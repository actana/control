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
  handleCoreHomeOp,
  handleCoreHomeOpSync,
  parseCoreHomeOpRequest,
  type CoreHomeOpContext,
  type CoreHomeOpRequest,
  type SyncRequest,
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
        "dirList",
        "ensureClaudeShiftEnterBinding",
        "ensureOrchestrationSkill",
        "ensureStatuslineTap",
        "installHarnessHooks",
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

  it.each([
    ["null", null],
    ["an array", [{ op: "dirList" }]],
    ["a string", "dirList"],
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
      { op: "dirList", path: null },
    ];
    for (const request of requests) expect(parseCoreHomeOpRequest(request)).toEqual(request);
  });
});

describe("path confinement: nothing outside the home is touched", () => {
  const hooks = (cwd: string): SyncRequest => ({ op: "installHarnessHooks", harness: "claude-code", cwd, piAgentDir: null });

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

  it("refuses a Pi agent dir outside the home, and expands `~` inside it", () => {
    const work = path.join(home, "w");
    fs.mkdirSync(work);
    const pi = (piAgentDir: string): SyncRequest => ({ op: "installHarnessHooks", harness: "pi", cwd: work, piAgentDir });
    expect(refusal(() => handleCoreHomeOpSync(pi(path.join(outside, "agent")), ctx)).code).toBe("path-escape");
    expect(filesUnder(outside)).toEqual([]);
    expect(handleCoreHomeOpSync(pi("~/.pi/agent"), ctx)).toMatchObject({ installed: true });
    expect(fs.existsSync(path.join(home, ".pi", "agent", "extensions", "actana-control.ts"))).toBe(true);
  });

  it("refuses to register into a registry that XDG_CONFIG_HOME moves outside the home", () => {
    const request: SyncRequest = {
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

  it("lists folders inside the home, stops 'up' at the home, and refuses to list outside it", async () => {
    fs.mkdirSync(path.join(home, "repos", "a"), { recursive: true });
    fs.mkdirSync(path.join(home, "repos", "b"));
    const top = await handleCoreHomeOp({ op: "dirList", path: null }, ctx);
    expect(top.path).toBe(home);
    expect(top.parent).toBeNull();
    expect(top.entries.map((e) => e.name)).toEqual(["repos"]);
    const repos = await handleCoreHomeOp({ op: "dirList", path: path.join(home, "repos") }, ctx);
    expect(repos.parent).toBe(home);
    expect(repos.entries.map((e) => e.name)).toEqual(["a", "b"]);

    await expect(handleCoreHomeOp({ op: "dirList", path: outside }, ctx)).rejects.toThrow("only lists folders inside its home");
    fs.symlinkSync(outside, path.join(home, "link"));
    await expect(handleCoreHomeOp({ op: "dirList", path: path.join(home, "link") }, ctx)).rejects.toThrow("only lists folders inside its home");
    await expect(handleCoreHomeOp({ op: "dirList", path: path.join(home, "nope") }, ctx)).rejects.toThrow("Folder not found");
  });

  it("keeps the picker's 'up' outside the container (roots null)", async () => {
    const listing = await handleCoreHomeOp({ op: "dirList", path: home }, { ...ctx, roots: null });
    expect(listing.parent).toBe(base);
  });

  it("does not run the async operation synchronously", () => {
    expect(() => handleCoreHomeOpSync({ op: "dirList", path: null } as never, ctx)).toThrow(/async/);
  });
});
