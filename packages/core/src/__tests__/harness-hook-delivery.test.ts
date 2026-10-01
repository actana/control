import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HookDeliveryMonitor,
  drainHookMisses,
  ensureHookMissDropBox,
  hookMissLogPath,
} from "../harness-hook-delivery";
import { CORE_HOOK_MISS_LOG, CORE_STATE_DIR } from "@actana/shared/actana-container-contract";
import { HOOK_MISS_LOG_ENV, hookCommand } from "../harness-hooks";
import {
  startHarnessHookReceiver,
  type HarnessHookReceiver,
} from "../harness-hook-receiver";

// Hook delivery, both ends (issue 243 part 1).
//
// The failure this covers is the one with no evidence: a hook POST that never
// landed, swallowed by `|| true`, leaving a Session wedged on `running` and
// nothing anywhere to say why. So the assertions below start at the real shell
// command a hook file carries, run it against a real receiver, and read the
// file it writes when the Core does not ack.

const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;
const hasCurl = spawnSync("sh", ["-c", "command -v curl"]).status === 0;
const shellAvailable = hasSh && hasCurl;

describe("recording hooks this Core never acked", () => {
  let dir: string;
  let missLog: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-hook-delivery-"));
    missLog = hookMissLogPath(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reads a recorded miss and clears the file so it is reported once", () => {
    fs.writeFileSync(
      missLog,
      "2026-08-17T10:54:51Z\tt-1\tStop\t28\n2026-08-17T10:55:02Z\tt-1\tSubagentStop\t7\n",
    );

    expect(drainHookMisses(missLog)).toEqual([
      { at: "2026-08-17T10:54:51Z", sessionId: "t-1", event: "Stop", code: "28" },
      { at: "2026-08-17T10:55:02Z", sessionId: "t-1", event: "SubagentStop", code: "7" },
    ]);
    // Drained means drained: a second pass must not re-report the same drops,
    // or the running total stops meaning anything.
    expect(drainHookMisses(missLog)).toEqual([]);
    expect(fs.readFileSync(missLog, "utf8")).toBe("");
  });

  it("says nothing at all when no hook has been dropped", () => {
    expect(drainHookMisses(missLog)).toEqual([]);
    fs.writeFileSync(missLog, "");
    expect(drainHookMisses(missLog)).toEqual([]);
  });

  it("drops a line it cannot read rather than guessing at it", () => {
    fs.writeFileSync(missLog, "garbage\n\n2026-08-17T10:54:51Z\tt-1\tStop\t28\n");
    expect(drainHookMisses(missLog)).toHaveLength(1);
  });

  it("keeps a running total, and reports what a dead Core's window recorded", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Written while this process was not running — the drops nobody could
    // otherwise hear about, since the Core that would have logged them was the
    // thing that was down.
    fs.writeFileSync(missLog, "2026-08-17T10:54:51Z\tt-1\tStop\t7\n");

    const monitor = new HookDeliveryMonitor({ missLogPath: missLog, intervalMs: 60_000 });
    monitor.start();
    expect(monitor.missCount()).toBe(1);

    fs.appendFileSync(missLog, "2026-08-17T11:00:00Z\tt-2\tStop\t28\n");
    monitor.drain();
    expect(monitor.missCount()).toBe(2);
    monitor.stop();

    const logged = warn.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).toContain("hook-delivery.missed");
    expect(logged).toContain("t-2");
  });
});

describe("the hook command's half of the ack", () => {
  it("checks the answer, retries a transient one, and still cannot fail a turn", () => {
    const command = hookCommand("claude", "Stop");
    // -f: without it curl exits 0 on a 401, a 404 and a 500 alike, so "the
    // Core took it" was never something this command could know.
    expect(command).toContain("-f");
    expect(command).toContain("--retry 2");
    // Whatever else it does, a hook may never take the operator's turn down.
    expect(command).toContain("|| true");
    // Claude Code reads hook stdout as control JSON; the receiver's answer has
    // no business being printed there.
    expect(command).toContain("-o /dev/null");
  });

  it("records what it could not deliver, and writes nowhere when unconfigured", () => {
    const command = hookCommand("claude", "Stop");
    expect(command).toContain(`$\{${HOOK_MISS_LOG_ENV}:-/dev/null}`);
    // The record names the session and the event, which is what makes a drop
    // attributable to the Session it wedged.
    expect(command).toContain('"Stop"');
    expect(command).toContain("$AC_HOOK_SESSION_ID");
  });
});

// The drop paths pay the command's own retry budget (three attempts, a second
// between them), so they need more than vitest's default 5s.
const DROP_PATH_TIMEOUT_MS = 40_000;

describe("the two ends together, run as a hook really runs them", () => {
  let dir: string;
  let missLog: string;
  let receiver: HarnessHookReceiver | null = null;
  let seen: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-hook-delivery-e2e-"));
    missLog = hookMissLogPath(dir);
    seen = [];
    receiver = await startHarnessHookReceiver((sessionId, _payload, eventName) => {
      seen.push(`${sessionId}:${eventName}`);
      // "t-gone" is a session this Core does not have — the 404 the pipeline
      // answers when a hook names a row that was deleted.
      return sessionId === "t-gone"
        ? { ok: false, body: { error: "session not found" } }
        : { ok: true, body: { ok: true, status: "finished" } };
    });
  });
  afterEach(() => {
    receiver?.close();
    receiver = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Run the hook the way a harness does — a real `sh`, a real `curl`, the
  // payload on stdin — and never synchronously: the receiver under test lives
  // in THIS event loop, so a blocking child would deadlock against the server
  // that is supposed to answer it.
  const runHook = (env: Record<string, string>): Promise<number> => {
    const script = path.join(dir, "hook.sh");
    fs.writeFileSync(script, hookCommand("claude", "Stop"));
    return new Promise((resolve, reject) => {
      const child = spawn("sh", [script], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 0));
      child.stdin.end(JSON.stringify({ hook_event_name: "Stop" }));
    });
  };

  it.skipIf(!shellAvailable)("acks a delivered hook and records nothing", async () => {
    await runHook({
      AC_HOOK_URL: receiver!.url,
      AC_HOOK_TOKEN: receiver!.token,
      AC_HOOK_SESSION_ID: "t-1",
      AC_HOOK_MISS_LOG: missLog,
    });

    expect(seen).toEqual(["t-1:Stop"]);
    expect(receiver!.acceptedCount()).toBe(1);
    expect(drainHookMisses(missLog)).toEqual([]);
  });

  it.skipIf(!shellAvailable)("records the drop when the Core is not there", async () => {
    // The Core is down (or its receiver's port moved with a restart) — the
    // lost `Stop` this whole issue is about.
    await runHook({
      AC_HOOK_URL: "http://127.0.0.1:1",
      AC_HOOK_TOKEN: "irrelevant",
      AC_HOOK_SESSION_ID: "t-wedged",
      AC_HOOK_MISS_LOG: missLog,
    });

    const misses = drainHookMisses(missLog);
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ sessionId: "t-wedged", event: "Stop" });
    expect(misses[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(receiver!.acceptedCount()).toBe(0);
  }, DROP_PATH_TIMEOUT_MS);

  it.skipIf(!shellAvailable)("records a refusal too — a 401 is a lost hook, not a delivered one", async () => {
    await runHook({
      AC_HOOK_URL: receiver!.url,
      AC_HOOK_TOKEN: "wrong-token",
      AC_HOOK_SESSION_ID: "t-1",
      AC_HOOK_MISS_LOG: missLog,
    });
    expect(drainHookMisses(missLog)).toHaveLength(1);
    expect(receiver!.acceptedCount()).toBe(0);

    // …and a session this Core no longer has, which is the other answer the old
    // `|| true` made indistinguishable from success.
    await runHook({
      AC_HOOK_URL: receiver!.url,
      AC_HOOK_TOKEN: receiver!.token,
      AC_HOOK_SESSION_ID: "t-gone",
      AC_HOOK_MISS_LOG: missLog,
    });
    expect(drainHookMisses(missLog)).toHaveLength(1);
    expect(receiver!.acceptedCount()).toBe(0);
  }, DROP_PATH_TIMEOUT_MS);

  it.skipIf(!shellAvailable)("stays fail-soft with no miss log configured at all", async () => {
    // A workspace opened by hand, or a Core that wired none: the command must
    // still exit 0 and write nowhere.
    const code = await runHook({
      AC_HOOK_URL: "http://127.0.0.1:1",
      AC_HOOK_TOKEN: "irrelevant",
      AC_HOOK_SESSION_ID: "t-1",
      AC_HOOK_MISS_LOG: "",
    });
    expect(code).toBe(0);
    expect(fs.existsSync(missLog)).toBe(false);
  }, DROP_PATH_TIMEOUT_MS);
});

// The miss log in the container is a drop box (#559): a Session appends to it,
// and the daemon, whose own state a Session cannot read, reads it back. What a
// Session wrote is input from a process that is not trusted, not a record.
describe("the hook miss drop box", () => {
  let dir: string;
  let missLog: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-hook-dropbox-"));
    missLog = path.join(dir, "drop", "hook-misses.log");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is outside the state directory in the container, and beside the database on metal", () => {
    expect(hookMissLogPath("/data", true)).toBe(CORE_HOOK_MISS_LOG);
    expect(CORE_HOOK_MISS_LOG.startsWith(`${CORE_STATE_DIR}/`)).toBe(false);
    expect(hookMissLogPath("/data")).toBe("/data/hook-misses.log");
    expect(hookMissLogPath("/data", false)).toBe("/data/hook-misses.log");
  });

  it("is made traversable and world-writable (0622) whatever the umask says", () => {
    const umask = process.umask(0o077);
    try {
      expect(ensureHookMissDropBox(missLog)).toBe(true);
    } finally {
      process.umask(umask);
    }
    expect(fs.statSync(path.dirname(missLog)).mode & 0o777).toBe(0o711);
    expect(fs.statSync(missLog).mode & 0o777).toBe(0o622);
  });

  it("keeps what is in an existing drop box and never throws when it cannot make one", () => {
    expect(ensureHookMissDropBox(missLog)).toBe(true);
    fs.writeFileSync(missLog, "x\ty\tz\t1\n");
    expect(ensureHookMissDropBox(missLog)).toBe(true);
    expect(fs.readFileSync(missLog, "utf8")).toBe("x\ty\tz\t1\n");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocked = path.join(dir, "plain-file");
    fs.writeFileSync(blocked, "");
    expect(ensureHookMissDropBox(path.join(blocked, "hook-misses.log"))).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).toContain("hook-delivery.drop-box-failed");
  });

  it("does not follow a symlink where the drop box should be, and does not chmod its target", () => {
    const target = path.join(dir, "elsewhere.log");
    fs.writeFileSync(target, "keep", { mode: 0o600 });
    fs.mkdirSync(path.dirname(missLog), { recursive: true });
    fs.symlinkSync(target, missLog);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(ensureHookMissDropBox(missLog)).toBe(false);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(warn.mock.calls.flat().join(" ")).toContain("hook-delivery.drop-box-failed");
  });

  it.skipIf(!shellAvailable)("takes the line a real hook command appends to it", () => {
    ensureHookMissDropBox(missLog);
    const result = spawnSync("sh", ["-c", hookCommand("claude", "Stop")], {
      encoding: "utf8",
      input: "{}",
      env: {
        ...process.env,
        AC_HOOK_URL: "http://127.0.0.1:1",
        AC_HOOK_TOKEN: "t",
        AC_HOOK_SESSION_ID: "t-drop",
        AC_HOOK_MISS_LOG: missLog,
      },
    });
    expect(result.status).toBe(0);
    expect(drainHookMisses(missLog).map((miss) => miss.sessionId)).toEqual(["t-drop"]);
  });

  describe("read as untrusted input", () => {
    beforeEach(() => {
      ensureHookMissDropBox(missLog);
    });

    it("reads no more than the cap, and drops the line the cap cut in two", () => {
      const line = "2026-01-01T00:00:00Z\tt-big\tStop\t28\n";
      const filler = Math.floor(999_950 / line.length);
      // The cap falls inside the code field of the last line, leaving a prefix
      // that has four tab-separated fields and would parse as a miss.
      const torn = `2026-01-01T00:00:00Z\tt-cut\tStop\t28${"1".repeat(28)}\n`;
      fs.writeFileSync(missLog, line.repeat(filler) + "x".repeat(999_950 - filler * line.length));
      fs.appendFileSync(missLog, torn.repeat(30_000));

      const misses = drainHookMisses(missLog);

      expect(misses.length).toBe(filler);
      expect(misses.some((miss) => miss.sessionId === "t-cut")).toBe(false);
      expect(fs.statSync(missLog).size).toBe(0);
    });

    it("reads fields as data: no control characters, bounded length, extra fields ignored", () => {
      const long = "x".repeat(10_000);
      fs.writeFileSync(
        missLog,
        [
          "2026-01-01T00:00:00Z\tt-\u001b[31mred\tSt\rop\t28\tsurplus\tfields",
          `2026-01-01T00:00:00Z\t${long}\tStop\t28`,
          `2026-01-01T00:00:00Z\t${"y".repeat(200)}\tStop\t28`,
          "\t\t\t",
          "\u0000\u0000\u0000",
          "2026-01-01T00:00:00Z\tt-c1\u009b\u2028x\tStop\t28",
        ].join("\n") + "\n",
      );

      const misses = drainHookMisses(missLog);

      expect(misses).toEqual([
        { at: "2026-01-01T00:00:00Z", sessionId: "t-[31mred", event: "Stop", code: "28" },
        { at: "2026-01-01T00:00:00Z", sessionId: "y".repeat(128), event: "Stop", code: "28" },
        { at: "2026-01-01T00:00:00Z", sessionId: "t-c1x", event: "Stop", code: "28" },
      ]);
    });

    it("does not follow a symlink to somewhere else, and does not clear what it points at", () => {
      const target = path.join(dir, "elsewhere.log");
      fs.writeFileSync(target, "2026-01-01T00:00:00Z\tt-1\tStop\t28\n");
      fs.rmSync(missLog);
      fs.symlinkSync(target, missLog);

      expect(drainHookMisses(missLog)).toEqual([]);
      expect(fs.readFileSync(target, "utf8")).toContain("t-1");
    });
  });
});
