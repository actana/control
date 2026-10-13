// The codex hook-trust check (#703): the Core's own hooks and trust entries go into a throwaway workspace, codex
// is asked to list them, and the answer is compared with what the Core wrote.
//
// A stand-in for codex (`fakeCodex`) speaks the three lines of the exchange and answers `hooks/list` from the
// config and hooks file the check wrote, the way codex 0.162.0 answers; its modes stand for what a real codex
// could do. The last block runs the check against a real codex when one is on PATH (or named in
// `ACTANA_CODEX_BIN`), and fails when that codex is newer than `CODEX_HOOK_HASH_VERIFIED` so the constant is
// never older than the newest codex a check has passed on.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractCliVersion, compareCliVersions } from "@actana/shared/harness-cli-version-compare";
import { resolveAllHarnessCommandsOnPath } from "@actana/shared/harness-cli-resolution";
import { hookEndpointSlug } from "@actana/shared/mission-control-hook-env";
import { checkCodexHookTrust, compareCodexHookTrust, CODEX_HOOK_CHECK_TIMEOUT_MS } from "../codex-hook-trust-check";
import { CODEX_HOOK_EVENTS, codexGroup } from "../harness-hooks";
import { CODEX_HOOK_HASH_VERIFIED, codexHookHash, ownedCodexHookTrust } from "../harness-pretrust";

let base: string;
let scratch: string;
let logFile: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-check-")));
  scratch = path.join(base, "home", ".cache", "actana");
  logFile = path.join(base, "fake-codex.json");
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/**
 * A `codex` whose `app-server` answers `initialize`, then `hooks/list` from the files the check wrote: one entry
 * per `[hooks.state."<key>"]` table in `$CODEX_HOME/config.toml`, listed as codex lists a project hook. Its
 * `FAKE_CODEX_MODE` picks what it does with them, and it writes what it saw to `FAKE_CODEX_LOG`.
 */
function fakeCodex(mode: string): string {
  const dir = path.join(base, "bin");
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(
    script,
    `
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const mode = ${JSON.stringify(mode)};
if (process.argv[2] !== "app-server") { process.stderr.write("not app-server"); process.exit(64); }
if (mode === "exit") { process.stderr.write("fake codex: refusing to start"); process.exit(3); }
if (mode === "chatter") process.stdout.write("not json at all\\n" + JSON.stringify({ method: "configWarning", params: {} }) + "\\n");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const seen = [];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  seen.push(msg.method);
  if (msg.method === "initialize") {
    if (mode === "init-error") return out({ id: msg.id, error: { code: -32600, message: "no" } });
    return out({ id: msg.id, result: { userAgent: "fake", codexHome: process.env.CODEX_HOME } });
  }
  if (msg.method !== "hooks/list") return;
  const cwd = msg.params.cwds[0];
  const config = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
  const hooksJson = fs.readFileSync(path.join(cwd, ".codex", "hooks.json"), "utf8");
  fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({ seen, cwd: process.cwd(), paramCwd: cwd, codexHome: process.env.CODEX_HOME, config, hooksJson }));
  if (mode === "hang") return;
  if (mode === "list-error") return out({ id: msg.id, error: { code: -32603, message: "hooks are off" } });
  if (mode === "not-a-list") return out({ id: msg.id, result: { data: "???" } });
  const hooks = [];
  for (const m of config.matchAll(/^\\[hooks\\.state\\."((?:[^"\\\\]|\\\\.)*)"\\]\\n\\s*trusted_hash = "([^"]*)"/gm)) {
    const key = m[1];
    const parts = key.split(":");
    const current = mode === "drift" ? "sha256:" + "0".repeat(64) : m[2];
    hooks.push({
      key, eventName: parts[parts.length - 3], handlerType: "command", command: "sh -c '...'", async: false, matcher: null,
      timeoutSec: 600, statusMessage: null, additionalContextLimit: null, sourcePath: parts.slice(0, -3).join(":"),
      source: "project", pluginId: null, displayOrder: hooks.length, enabled: true, isManaged: false,
      currentHash: current, trustStatus: mode === "drift" ? "modified" : mode === "untrusted" ? "untrusted" : "trusted",
    });
  }
  if (mode === "missing") hooks.pop();
  out({ id: msg.id, result: { data: [{ cwd, hooks, warnings: [], errors: [] }] } });
});
`,
  );
  const binary = path.join(dir, "codex");
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return binary;
}

const seenByFake = () => JSON.parse(fs.readFileSync(logFile, "utf8")) as Record<string, string | string[]>;

describe("checkCodexHookTrust: this Core's hooks, as codex lists them from a throwaway workspace", () => {
  it("writes the hooks and their trust the way a Session gets them, asks codex in that workspace, and is verified when codex agrees", async () => {
    const check = await checkCodexHookTrust(fakeCodex("echo"), scratch, { PATH: "/usr/bin:/bin" });
    expect(check).toEqual({ verified: true, hooks: expect.any(Array) });
    expect(check.hooks.map((h) => h.event).sort()).toEqual(["permission_request", "stop", "user_prompt_submit"]);
    for (const hook of check.hooks) {
      expect(hook.actual).toBe(hook.expected);
      expect(hook.trustStatus).toBe("trusted");
      expect(hook.expected).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    const seen = seenByFake();
    expect(seen.seen).toEqual(["initialize", "initialized", "hooks/list"]);
    // In the throwaway workspace, with a throwaway CODEX_HOME beside it, both under the check root.
    expect(seen.cwd).toBe(seen.paramCwd);
    expect(path.relative(scratch, seen.cwd as string)).toMatch(/^codex-hook-check-[^/]+\/workspace$/);
    expect(path.relative(scratch, seen.codexHome as string)).toMatch(/^codex-hook-check-[^/]+\/codex-home$/);
    // The hooks file is the one `installHarnessHooks("codex")` writes, and the trust is what the writers write.
    const hooks = (JSON.parse(seen.hooksJson as string) as { hooks: Record<string, unknown[]> }).hooks;
    for (const event of CODEX_HOOK_EVENTS) expect(hooks[event]).toEqual([codexGroup(hookEndpointSlug("codex"), event)]);
    expect(seen.config).toContain(`[projects."${seen.cwd}"]\ntrust_level = "trusted"`);
    for (const event of CODEX_HOOK_EVENTS) {
      const hash = codexHookHash(event, { command: (codexGroup(hookEndpointSlug("codex"), event).hooks as { command: string }[])[0]!.command });
      expect(seen.config).toContain(`trusted_hash = "${hash}"`);
    }
  });

  it("removes the workspace and the CODEX_HOME afterwards, verified or not", async () => {
    await checkCodexHookTrust(fakeCodex("echo"), scratch, {});
    expect(fs.readdirSync(scratch)).toEqual([]);
    await checkCodexHookTrust(fakeCodex("drift"), scratch, {});
    expect(fs.readdirSync(scratch)).toEqual([]);
    await expect(checkCodexHookTrust(fakeCodex("exit"), scratch, {})).rejects.toThrow();
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it("is not verified when codex hashes a hook differently, and says which", async () => {
    const check = await checkCodexHookTrust(fakeCodex("drift"), scratch, {});
    expect(check.verified).toBe(false);
    expect(check.reason).toBe("codex hashes user_prompt_submit, stop, permission_request differently from this Core");
    for (const hook of check.hooks) {
      expect(hook.actual).toBe(`sha256:${"0".repeat(64)}`);
      expect(hook.actual).not.toBe(hook.expected);
      expect(hook.trustStatus).toBe("modified");
    }
  });

  it("is not verified when codex agrees on the hash but does not read the entry as trusted", async () => {
    const check = await checkCodexHookTrust(fakeCodex("untrusted"), scratch, {});
    expect(check.verified).toBe(false);
    expect(check.reason).toMatch(/^codex reads the trusted_hash this Core wrote for .* as untrusted, untrusted, untrusted$/);
  });

  it("is not verified when codex does not list one of the hooks", async () => {
    const check = await checkCodexHookTrust(fakeCodex("missing"), scratch, {});
    expect(check.verified).toBe(false);
    expect(check.reason).toMatch(/^codex did not list \w+ from the check workspace$/);
    expect(check.hooks.filter((h) => h.actual === null)).toHaveLength(1);
  });

  it("reads past codex's notifications and anything that is not JSON", async () => {
    expect((await checkCodexHookTrust(fakeCodex("chatter"), scratch, {})).verified).toBe(true);
  });

  it("rejects when codex does not answer in time, and does not leave it running", async () => {
    const started = Date.now();
    await expect(checkCodexHookTrust(fakeCodex("hang"), scratch, {}, { timeoutMs: 1_500 })).rejects.toThrow(
      /did not answer hooks\/list within 1500 ms/,
    );
    expect(Date.now() - started).toBeLessThan(CODEX_HOOK_CHECK_TIMEOUT_MS);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it("rejects when codex exits, refuses initialize, refuses hooks/list, or answers with something else", async () => {
    await expect(checkCodexHookTrust(fakeCodex("exit"), scratch, {})).rejects.toThrow(/exited \(3\) before answering hooks\/list.*refusing to start/);
    await expect(checkCodexHookTrust(fakeCodex("init-error"), scratch, {})).rejects.toThrow(/refused initialize: no/);
    await expect(checkCodexHookTrust(fakeCodex("list-error"), scratch, {})).rejects.toThrow(/refused hooks\/list: hooks are off/);
    await expect(checkCodexHookTrust(fakeCodex("not-a-list"), scratch, {})).rejects.toThrow(/not a hook list/);
    await expect(checkCodexHookTrust(path.join(base, "no-such-codex"), scratch, {})).rejects.toThrow(/could not be started/);
  });
});

describe("compareCodexHookTrust", () => {
  const file = "/home/core/.cache/actana/codex-hook-check-x/workspace/.codex/hooks.json";
  const trusted = (key: string, hash: string) => ({ key, currentHash: hash, trustStatus: "trusted" });

  it("matches a hook listed under any spelling of its file, once", () => {
    fs.mkdirSync(path.join(base, "ws", ".codex"), { recursive: true });
    const hooksFile = path.join(base, "ws", ".codex", "hooks.json");
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: Object.fromEntries(CODEX_HOOK_EVENTS.map((e) => [e, [codexGroup(hookEndpointSlug("codex"), e)]])) }));
    const real = "/real/home/ws/.codex/hooks.json";
    const expected = ownedCodexHookTrust(hooksFile, [hooksFile, real]);
    expect(expected).toHaveLength(CODEX_HOOK_EVENTS.length * 2);
    const listed = expected.filter(([key]) => key.startsWith(real)).map(([key, hash]) => trusted(key, hash));
    const check = compareCodexHookTrust(expected, listed);
    expect(check.verified).toBe(true);
    expect(check.hooks).toHaveLength(CODEX_HOOK_EVENTS.length);
    expect(check.hooks.every((h) => h.key.startsWith(real))).toBe(true);
  });

  it("says so when the Core's side is short of a hook", () => {
    const check = compareCodexHookTrust([[`${file}:stop:0:0`, "sha256:a"]], [trusted(`${file}:stop:0:0`, "sha256:a")]);
    expect(check).toMatchObject({ verified: false, reason: "this Core wrote 1 of its 3 codex hooks into the check workspace" });
  });
});

// ─── against a real codex, when there is one ────────────────────────
//
// `ACTANA_CODEX_BIN` names a codex binary; otherwise the first `codex` on PATH is used; with neither this block is
// skipped. The second expectation is the one the issue asked for: it fails as soon as the codex on the host is
// newer than the release `CODEX_HOOK_HASH_VERIFIED` names, once the first has shown the hash still holds.

const realCodex = process.env.ACTANA_CODEX_BIN?.trim() || resolveAllHarnessCommandsOnPath("codex", process.env, os.platform())[0] || null;

describe.skipIf(realCodex === null)("against the codex on this host", () => {
  it(
    "reproduces the hash of the installed codex, which is no newer than CODEX_HOOK_HASH_VERIFIED",
    async () => {
      const binary = realCodex!;
      // A home of its own under the real one: codex refuses a HOME it cannot write, and writes beside CODEX_HOME.
      const home = fs.mkdtempSync(path.join(os.homedir(), ".codex-hook-check-test-"));
      try {
        const env = { ...process.env, HOME: home };
        const probe = spawnSync(binary, ["--version"], { encoding: "utf8", env, timeout: 15_000 });
        const version = extractCliVersion(`${probe.stdout}\n${probe.stderr}`);
        expect(version, `${binary} --version printed no version: ${probe.stdout} ${probe.stderr}`).not.toBeNull();

        const check = await checkCodexHookTrust(binary, path.join(home, ".cache", "actana"), env);
        expect(check, `codex ${version} at ${binary}: ${check.reason ?? ""}\n${JSON.stringify(check.hooks, null, 2)}`).toMatchObject({ verified: true });
        expect(
          compareCliVersions(version!, CODEX_HOOK_HASH_VERIFIED),
          `codex ${version} is newer than ${CODEX_HOOK_HASH_VERIFIED}, the release CODEX_HOOK_HASH_VERIFIED names, and the hash still holds on it: move the constant (harness-pretrust.ts) up to ${version}`,
        ).toBeLessThanOrEqual(0);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
