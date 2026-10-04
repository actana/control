// The helper's operations and, above all, its request validation (issue 559, PR 3).
//
// The helper runs as `core`, so a bad request can do no more than a Session can.
// What these tests hold is that it is still not a confused deputy: an unknown
// operation does nothing, a path that leaves the home (by `..`, by an absolute
// path, by a symlink inside the home, by a dangling one) is refused *before* any
// file is touched, and an operation that is allowed does its work where it should.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CORE_HOME_OPERATIONS,
  CoreHomeOpFailedError,
  CoreHomeOpRefusedError,
  handleCoreHomeOpSync,
  parseCoreHomeOpRequest,
  type CoreHomeOpContext,
  type CoreHomeOpRequest,
} from "../core-home-ops";

let base: string;
let home: string;
let outside: string;
let ctx: CoreHomeOpContext;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "core-home-ops-")));
  home = path.join(base, "home");
  outside = path.join(base, "outside");
  fs.mkdirSync(home);
  fs.mkdirSync(outside);
  // The helper's HOME is core's home; the writers that follow `coreHome()` read it.
  vi.stubEnv("HOME", home);
  ctx = { home, roots: [home], env: { HOME: home } };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

const refusal = (fn: () => unknown): CoreHomeOpRefusedError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CoreHomeOpRefusedError);
    return err as CoreHomeOpRefusedError;
  }
  throw new Error("expected a refusal, got a result");
};

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

describe("request validation: known operations only", () => {
  it("lists exactly the operations the plan names", () => {
    expect([...CORE_HOME_OPERATIONS].sort()).toEqual(
      [
        "ensureClaudeShiftEnterBinding",
        "ensureOrchestrationSkill",
        "ensureStatuslineTap",
        "installHarnessHooks",
        "pretrustWorkspaces",
        "probeHarnessCli",
        "resolveCommand",
        "resolveExecCwd",
        "spawnPathFacts",
        "wireLocalCore",
      ].sort(),
    );
  });

  it.each([
    ["an operation nobody defined", { op: "rm -rf" }],
    ["a prototype name", { op: "constructor" }],
    ["no operation", {}],
    ["a number for the operation", { op: 7 }],
  ])("refuses %s as unknown-op", (_name, raw) => {
    expect(refusal(() => parseCoreHomeOpRequest(raw)).code).toBe("unknown-op");
  });

  it.each([["dirList", { op: "dirList", path: null }], ["createDirectory", { op: "createDirectory", parent: "/h", name: "x" }]])(
    "refuses %s, which went with the folder picker (#555), as unknown-op",
    (_name, raw) => {
      expect(refusal(() => parseCoreHomeOpRequest(raw)).code).toBe("unknown-op");
    },
  );

  it.each([
    ["null", null],
    ["an array", [{ op: "resolveExecCwd" }]],
    ["a string", "resolveExecCwd"],
  ])("refuses %s as bad-request", (_name, raw) => {
    expect(refusal(() => parseCoreHomeOpRequest(raw)).code).toBe("bad-request");
  });

  it("refuses a field the operation does not have, rather than ignoring it", () => {
    const err = refusal(() => parseCoreHomeOpRequest({ op: "ensureStatuslineTap", cwd: "/x", command: "id" }));
    expect(err.code).toBe("bad-request");
    expect(err.message).toContain("command");
  });

  it.each([
    ["a NUL in a path", { op: "ensureStatuslineTap", cwd: "/x\0y" }],
    ["an empty path", { op: "ensureStatuslineTap", cwd: "" }],
    ["a path that is not a string", { op: "ensureStatuslineTap", cwd: 5 }],
    ["an enormous path", { op: "ensureStatuslineTap", cwd: `/${"a".repeat(5000)}` }],
    ["a harness that is a path", { op: "installHarnessHooks", harness: "../x", cwd: "/x", piAgentDir: null }],
    ["too many roots", { op: "spawnPathFacts", cwd: "/x", roots: Array.from({ length: 300 }, (_, i) => `/r${i}`) }],
    ["a command that is a path", { op: "resolveCommand", command: "/tmp/evil", path: null }],
    ["a probed command that is a path", { op: "probeHarnessCli", command: "/tmp/evil", path: null }],
    ["a probed command with an argument", { op: "probeHarnessCli", command: "claude --version", path: null }],
    ["a command with a separator", { op: "resolveCommand", command: "../claude", path: null }],
    ["a command with a space", { op: "resolveCommand", command: "claude --version", path: null }],
    ["a PATH with a NUL", { op: "resolveCommand", command: "claude", path: "/a\0:/b" }],
    ["a PATH that is not a string", { op: "resolveCommand", command: "claude", path: ["/a"] }],
    ["a credential that is not an object", { op: "wireLocalCore", label: "a", credential: "x" }],
  ])("refuses %s as bad-field", (_name, raw) => {
    expect(["bad-field", "bad-request"]).toContain(refusal(() => parseCoreHomeOpRequest(raw)).code);
  });

  it("accepts every well-formed request", () => {
    const requests: CoreHomeOpRequest[] = [
      { op: "installHarnessHooks", harness: "claude-code", cwd: "/h/w", piAgentDir: null },
      { op: "ensureStatuslineTap", cwd: "/h/w" },
      { op: "ensureClaudeShiftEnterBinding" },
      { op: "ensureOrchestrationSkill" },
      { op: "wireLocalCore", label: "", credential: { endpoint: "wss://127.0.0.1:1", label: "", caCert: "a", clientCert: "b", clientKey: "c", bearer: "d" } },
      { op: "spawnPathFacts", cwd: "/h/w", roots: ["/h/w"] },
      { op: "resolveExecCwd", cwd: null },
      { op: "resolveCommand", command: "claude", path: "/h/.local/bin:/usr/bin" },
      { op: "resolveCommand", command: "claude", path: null },
    ];
    for (const request of requests) expect(parseCoreHomeOpRequest(request)).toEqual(request);
  });
});

describe("path confinement: nothing outside the home is touched", () => {
  const hooks = (cwd: string): CoreHomeOpRequest => ({ op: "installHarnessHooks", harness: "claude-code", cwd, piAgentDir: null });

  it("writes hooks into a workspace inside the home", () => {
    const work = path.join(home, "repos", "app");
    fs.mkdirSync(work, { recursive: true });
    const result = handleCoreHomeOpSync(hooks(work), ctx);
    expect(result).toMatchObject({ installed: true, reportsTurnStart: true });
    expect(fs.existsSync(path.join(work, ".claude", "settings.local.json"))).toBe(true);
  });

  it("refuses an absolute path outside the home, and writes nothing there", () => {
    const err = refusal(() => handleCoreHomeOpSync(hooks(outside), ctx));
    expect(err.code).toBe("path-escape");
    expect(filesUnder(outside)).toEqual([]);
  });

  it("refuses `..` that climbs out of the home, however it is spelt", () => {
    const sneaky = `${home}/repos/../../outside`;
    expect(refusal(() => handleCoreHomeOpSync(hooks(sneaky), ctx)).code).toBe("path-escape");
    expect(filesUnder(outside)).toEqual([]);
  });

  it("refuses a sibling whose name merely starts with the home's", () => {
    const sibling = `${home}-evil`;
    fs.mkdirSync(sibling);
    expect(refusal(() => handleCoreHomeOpSync(hooks(sibling), ctx)).code).toBe("path-escape");
    expect(filesUnder(sibling)).toEqual([]);
  });

  it("refuses a relative path, even one that would resolve inside the home", () => {
    fs.mkdirSync(path.join(home, "repos", "app"), { recursive: true });
    // Resolved against the helper's own cwd (which `asCore` makes core's home), it
    // would land in the home: it is refused anyway, because nothing relative is a
    // path anybody chose.
    vi.spyOn(process, "cwd").mockReturnValue(home);
    expect(refusal(() => handleCoreHomeOpSync(hooks("repos/app"), ctx)).code).toBe("path-escape");
    expect(fs.existsSync(path.join(home, "repos", "app", ".claude"))).toBe(false);
  });

  it("refuses a symlink inside the home that points outside it, and does not follow it", () => {
    fs.symlinkSync(outside, path.join(home, "link"));
    const err = refusal(() => handleCoreHomeOpSync(hooks(path.join(home, "link")), ctx));
    expect(err.code).toBe("path-escape");
    // Nor a path that goes *through* it to a folder that does not exist yet.
    expect(refusal(() => handleCoreHomeOpSync(hooks(path.join(home, "link", "new", "deeper")), ctx)).code).toBe("path-escape");
    expect(filesUnder(outside)).toEqual([]);
  });

  it("refuses a dangling symlink, which a write would create the far end of", () => {
    fs.symlinkSync(path.join(outside, "not-yet"), path.join(home, "dangling"));
    expect(refusal(() => handleCoreHomeOpSync(hooks(path.join(home, "dangling")), ctx)).code).toBe("path-escape");
    expect(fs.existsSync(path.join(outside, "not-yet"))).toBe(false);
  });

  it("follows a symlink that stays inside the home", () => {
    const real = path.join(home, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(home, "alias"));
    handleCoreHomeOpSync(hooks(path.join(home, "alias")), ctx);
    expect(fs.existsSync(path.join(real, ".claude", "settings.local.json"))).toBe(true);
  });

  it("refuses Shift+Enter when ~/.claude is a link out of the home", () => {
    fs.symlinkSync(outside, path.join(home, ".claude"));
    expect(refusal(() => handleCoreHomeOpSync({ op: "ensureClaudeShiftEnterBinding" }, ctx)).code).toBe("path-escape");
    expect(filesUnder(outside)).toEqual([]);
  });

  it.each([
    ["claude-code", ".claude", ".claude/settings.local.json"],
    ["codex", ".codex", ".codex/hooks.json"],
    ["cursor-cli", ".cursor", ".cursor/hooks.json"],
    ["opencode", ".opencode", ".opencode/plugins/actana-control.js"],
  ])("refuses %s hooks when the workspace's %s is a link out of the home, and writes nothing through it", (harness, dirName, file) => {
    const work = path.join(home, "p2");
    fs.mkdirSync(work);
    const target = path.join(outside, "c2");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(work, dirName));
    const err = refusal(() => handleCoreHomeOpSync({ op: "installHarnessHooks", harness, cwd: work, piAgentDir: null }, ctx));
    expect(err.code).toBe("path-escape");
    expect(err.message).toContain("hook file");
    expect(filesUnder(outside)).toEqual([]);
    expect(file.startsWith(dirName)).toBe(true);
  });

  it("refuses a hook file that is itself a link to a file outside the home", () => {
    const work = path.join(home, "p3");
    fs.mkdirSync(path.join(work, ".claude"), { recursive: true });
    const victim = path.join(outside, "victim.json");
    fs.writeFileSync(victim, "{}");
    fs.symlinkSync(victim, path.join(work, ".claude", "settings.local.json"));
    expect(refusal(() => handleCoreHomeOpSync(hooks(work), ctx)).code).toBe("path-escape");
    expect(fs.readFileSync(victim, "utf8")).toBe("{}");
  });

  it("refuses Pi's hook when its extensions folder is a link out of the home", () => {
    const work = path.join(home, "w");
    fs.mkdirSync(work);
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.symlinkSync(outside, path.join(home, ".pi", "agent", "extensions"));
    const err = refusal(() => handleCoreHomeOpSync({ op: "installHarnessHooks", harness: "pi", cwd: work, piAgentDir: null }, ctx));
    expect(err.code).toBe("path-escape");
    expect(filesUnder(outside)).toEqual([]);
  });

  it("refuses the statusline tap when the workspace's .claude, or ~/.claude/mission-control, is a link out", () => {
    const work = path.join(home, "p4");
    fs.mkdirSync(work);
    fs.symlinkSync(outside, path.join(work, ".claude"));
    expect(refusal(() => handleCoreHomeOpSync({ op: "ensureStatuslineTap", cwd: work }, ctx)).code).toBe("path-escape");
    expect(filesUnder(outside)).toEqual([]);

    const work2 = path.join(home, "p5");
    fs.mkdirSync(work2);
    fs.mkdirSync(path.join(home, ".claude"));
    fs.symlinkSync(outside, path.join(home, ".claude", "mission-control"));
    expect(refusal(() => handleCoreHomeOpSync({ op: "ensureStatuslineTap", cwd: work2 }, ctx)).code).toBe("path-escape");
    expect(filesUnder(outside)).toEqual([]);
  });

  it("refuses the skill install when a Harness's skills folder is a link out of the home", () => {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.symlinkSync(outside, path.join(home, ".claude", "skills"));
    const err = refusal(() => handleCoreHomeOpSync({ op: "ensureOrchestrationSkill" }, ctx));
    expect(err.code).toBe("path-escape");
    expect(err.message).toContain("skill folder");
    expect(filesUnder(outside)).toEqual([]);
  });

  it("refuses a Pi agent dir outside the home, and expands `~` inside it", () => {
    const work = path.join(home, "w");
    fs.mkdirSync(work);
    const pi = (piAgentDir: string): CoreHomeOpRequest => ({ op: "installHarnessHooks", harness: "pi", cwd: work, piAgentDir });
    expect(refusal(() => handleCoreHomeOpSync(pi(path.join(outside, "agent")), ctx)).code).toBe("path-escape");
    expect(filesUnder(outside)).toEqual([]);
    expect(handleCoreHomeOpSync(pi("~/.pi/agent"), ctx)).toMatchObject({ installed: true });
    expect(fs.existsSync(path.join(home, ".pi", "agent", "extensions", "actana-control.ts"))).toBe(true);
  });

  it("refuses to register into a registry that XDG_CONFIG_HOME moves outside the home", () => {
    const request: CoreHomeOpRequest = {
      op: "wireLocalCore",
      label: "core-01",
      credential: { endpoint: "wss://127.0.0.1:8443", label: "core-01", caCert: "ca", clientCert: "cc", clientKey: "ck", bearer: "b" },
    };
    const escaped = { ...ctx, env: { HOME: home, XDG_CONFIG_HOME: outside } };
    expect(refusal(() => handleCoreHomeOpSync(request, escaped)).code).toBe("path-escape");
    expect(filesUnder(outside)).toEqual([]);
    expect(handleCoreHomeOpSync(request, ctx)).toMatchObject({ name: "core-01", selected: true });
    expect(fs.existsSync(path.join(home, ".config", "actana", "cores", "core-01.txt"))).toBe(true);
  });

  it("is not confined outside the container (roots null): daemon and operator are one user", () => {
    const loose: CoreHomeOpContext = { ...ctx, roots: null };
    expect(handleCoreHomeOpSync(hooks(outside), loose)).toMatchObject({ installed: true });
    expect(fs.existsSync(path.join(outside, ".claude", "settings.local.json"))).toBe(true);
  });
});

describe("operations", () => {
  it("sets Claude Code's Shift+Enter flag once, keeping the rest of the file", () => {
    const file = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ theme: "dark" }));
    handleCoreHomeOpSync({ op: "ensureClaudeShiftEnterBinding" }, ctx);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ theme: "dark", shiftEnterKeyBindingInstalled: true });
  });

  it("leaves a settings file it cannot parse alone", () => {
    const file = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "{not json");
    handleCoreHomeOpSync({ op: "ensureClaudeShiftEnterBinding" }, ctx);
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
  });

  it("installs the statusline tap script and points the workspace at it", () => {
    const work = path.join(home, "w");
    fs.mkdirSync(work);
    handleCoreHomeOpSync({ op: "ensureStatuslineTap", cwd: work }, ctx);
    expect(fs.existsSync(path.join(home, ".claude", "mission-control", "statusline-tap.sh"))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(work, ".claude", "settings.local.json"), "utf8"));
    expect(settings.statusLine.command).toBe(path.join(home, ".claude", "mission-control", "statusline-tap.sh"));
  });

  it("installs the orchestration skill into the Harnesses' folders and answers with the entries", () => {
    fs.mkdirSync(path.join(home, ".claude"));
    const entries = handleCoreHomeOpSync({ op: "ensureOrchestrationSkill" }, ctx) as Array<{ harness: string; outcome: string }>;
    expect(entries.some((e) => e.harness === "claude-code" && e.outcome === "written")).toBe(true);
    expect(filesUnder(path.join(home, ".claude", "skills")).length).toBeGreaterThan(0);
  });

  it("answers the spawn policy's questions in one go, and finds nothing outside the home", () => {
    const work = path.join(home, "repos", "app");
    fs.mkdirSync(work, { recursive: true });
    fs.symlinkSync(outside, path.join(home, "link"));
    const facts = handleCoreHomeOpSync(
      { op: "spawnPathFacts", cwd: work, roots: [path.join(home, "repos"), outside, path.join(home, "link"), path.join(home, "nope")] },
      ctx,
    );
    expect(facts.cwdOk).toBe(true);
    expect(facts.realpaths).toEqual({
      [work]: work,
      [path.join(home, "repos")]: path.join(home, "repos"),
      [outside]: null,
      [path.join(home, "link")]: null,
      [path.join(home, "nope")]: null,
    });
    const escaped = handleCoreHomeOpSync({ op: "spawnPathFacts", cwd: outside, roots: [] }, ctx);
    expect(escaped.cwdOk).toBe(false);
  });

  it("reports a cwd that is a file or is missing as not ok", () => {
    const file = path.join(home, "f");
    fs.writeFileSync(file, "x");
    expect(handleCoreHomeOpSync({ op: "spawnPathFacts", cwd: file, roots: [] }, ctx).cwdOk).toBe(false);
    expect(handleCoreHomeOpSync({ op: "spawnPathFacts", cwd: path.join(home, "nope"), roots: [] }, ctx).cwdOk).toBe(false);
  });

  it("resolves a `core exec` cwd with the operator's sentences", () => {
    const work = path.join(home, "w");
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(home, "f"), "x");
    expect(handleCoreHomeOpSync({ op: "resolveExecCwd", cwd: null }, ctx)).toEqual({ cwd: home });
    expect(handleCoreHomeOpSync({ op: "resolveExecCwd", cwd: `  ${work} ` }, ctx)).toEqual({ cwd: work });
    expect(() => handleCoreHomeOpSync({ op: "resolveExecCwd", cwd: path.join(home, "nope") }, ctx)).toThrow(
      new CoreHomeOpFailedError(`No such directory on this Core: ${path.join(home, "nope")}`),
    );
    expect(() => handleCoreHomeOpSync({ op: "resolveExecCwd", cwd: path.join(home, "f") }, ctx)).toThrow(
      `Not a directory on this Core: ${path.join(home, "f")}`,
    );
    expect(() => handleCoreHomeOpSync({ op: "resolveExecCwd", cwd: outside }, ctx)).toThrow(/Not inside this Core's home/);
  });
});

describe("resolveCommand: where a Harness CLI is, looked up by core", () => {
  const exe = (dir: string, name: string, mode = 0o755) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\n", { mode });
    fs.chmodSync(file, mode);
    return file;
  };
  const resolve = (command: string, pathValue: string | null) =>
    handleCoreHomeOpSync({ op: "resolveCommand", command, path: pathValue }, ctx);

  it("lists every executable match on the given PATH, in PATH order", () => {
    const local = exe(path.join(home, ".local", "bin"), "claude");
    const system = exe(path.join(outside, "bin"), "claude");
    expect(resolve("claude", [path.dirname(local), path.dirname(system)].join(":"))).toEqual({ candidates: [local, system] });
  });

  it("finds a binary in a directory outside the home: a PATH lookup is a read, not a write, so it is not confined", () => {
    const system = exe(path.join(outside, "bin"), "claude");
    expect(resolve("claude", path.dirname(system))).toEqual({ candidates: [system] });
  });

  it("skips a file that is not executable and a directory of that name", () => {
    exe(path.join(home, "a"), "claude", 0o644);
    fs.mkdirSync(path.join(home, "b", "claude"), { recursive: true });
    expect(resolve("claude", `${path.join(home, "a")}:${path.join(home, "b")}`)).toEqual({ candidates: [] });
  });

  it("reads the helper's own PATH when the request carries none", () => {
    const local = exe(path.join(home, ".local", "bin"), "claude");
    const there = handleCoreHomeOpSync(
      { op: "resolveCommand", command: "claude", path: null },
      { ...ctx, env: { HOME: home, PATH: path.dirname(local) } },
    );
    expect(there).toEqual({ candidates: [local] });
  });

  it("follows the Harness's alias list, as the daemon's own lookup did", () => {
    const agent = exe(path.join(outside, "bin"), "agent");
    expect(resolve("cursor-agent", path.dirname(agent)).candidates).toEqual([agent]);
  });

  it("finds nothing for a command that is not there", () => {
    expect(resolve("claude", outside)).toEqual({ candidates: [] });
  });
});

describe("probeHarnessCli: the version check runs in the helper, as core", () => {
  const script = (dir: string, name: string, body: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const probe = (command: string, pathValue: string) =>
    handleCoreHomeOpSync({ op: "probeHarnessCli", command, path: pathValue }, ctx);

  it("finds the binary and checks its version", () => {
    const file = script(path.join(home, ".local", "bin"), "claude", "echo 99.0.0");
    const answer = probe("claude", path.dirname(file));
    expect(answer.candidates).toEqual([file]);
    expect(answer.meeting).toMatchObject({ binary: file, check: { ok: true, version: "99.0.0" } });
  });

  it("reports a binary below the floor with its failed check", () => {
    const file = script(path.join(home, ".local", "bin"), "claude", "echo 0.0.1");
    expect(probe("claude", path.dirname(file)).meeting).toMatchObject({ binary: file, check: { ok: false, reason: "outdated" } });
  });

  it("finds nothing for a command that is not there", () => {
    expect(probe("claude", outside)).toEqual({ candidates: [], meeting: null });
  });

  // The daemon cannot signal core, so it must never wait on this itself; here the wait is
  // core's own, bounded by the check's timeout, and the helper answers rather than hangs.
  it("answers for a binary whose --version never returns, within the check's own bound", () => {
    const file = script(path.join(home, ".local", "bin"), "claude", "exec sleep 60");
    const started = Date.now();
    const answer = probe("claude", path.dirname(file));
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(answer.meeting).toMatchObject({ binary: file, check: { ok: false } });
  }, 15_000);
});

describe("pretrustWorkspaces (#685)", () => {
  const request = (dirs: string[], harnesses = ["claude-code", "codex"]) =>
    parseCoreHomeOpRequest({ op: "pretrustWorkspaces", harnesses, dirs }) as Extract<CoreHomeOpRequest, { op: "pretrustWorkspaces" }>;

  it("is a listed operation and writes both configs inside the home", () => {
    expect(CORE_HOME_OPERATIONS).toContain("pretrustWorkspaces");
    const results = handleCoreHomeOpSync(request([home]), ctx);
    expect(results.map((r) => [r.harness, r.outcome])).toEqual([
      ["claude-code", "written"],
      ["codex", "written"],
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).projects[home].hasTrustDialogAccepted).toBe(true);
    expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toContain(`trust_level = "trusted"`);
    expect(handleCoreHomeOpSync(request([home]), ctx).map((r) => r.outcome)).toEqual(["unchanged", "unchanged"]);
  });

  it("refuses a directory outside the home before touching anything", () => {
    expect(refusal(() => handleCoreHomeOpSync(request([outside]), ctx)).code).toBe("path-escape");
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  it("refuses a config file that is a link leading out of the home", () => {
    fs.writeFileSync(path.join(outside, "target.json"), "{}");
    fs.symlinkSync(path.join(outside, "target.json"), path.join(home, ".claude.json"));
    expect(refusal(() => handleCoreHomeOpSync(request([home]), ctx)).code).toBe("path-escape");
    expect(fs.readFileSync(path.join(outside, "target.json"), "utf8")).toBe("{}");
  });

  it("refuses malformed fields and unknown extras", () => {
    expect(() => parseCoreHomeOpRequest({ op: "pretrustWorkspaces", harnesses: ["Bad Id"], dirs: [home] })).toThrow(CoreHomeOpRefusedError);
    expect(() => parseCoreHomeOpRequest({ op: "pretrustWorkspaces", harnesses: [], dirs: [home], cmd: "x" })).toThrow(CoreHomeOpRefusedError);
    expect(() => parseCoreHomeOpRequest({ op: "pretrustWorkspaces", harnesses: [], dirs: "x" })).toThrow(CoreHomeOpRefusedError);
  });
});
