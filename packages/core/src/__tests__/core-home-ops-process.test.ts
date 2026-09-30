// The real helper bundle, as a real child process (issue 559, PR 3).
//
// Everything else stubs the process. This bundles `core-home-ops-entry.ts` with
// esbuild the way `build.mjs` does, then runs it with `node`, feeding stdin and
// reading the exit status, stdout and stderr: the actual channel the daemon reads.
// It cannot `setpriv` (no root here), so the launch wrapper is the identity with a
// clean environment; `asCore`'s argv is pinned in `core-home.test.ts` and
// `core-home-ops-client.test.ts`.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreHomeOpFailedError,
  CoreHomeOpRefusedError,
  coreHomeOp,
  coreHomeOpSync,
  type CoreHomeOpsOptions,
} from "../core-home-ops-client";

let workDir: string;
let bundle: string;
let home: string;
let outside: string;

beforeAll(async () => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "core-home-ops-bundle-")));
  bundle = path.join(workDir, "core-home-ops.cjs");
  await build({
    entryPoints: [path.resolve(__dirname, "../core-home-ops-entry.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    logLevel: "silent",
    external: ["better-sqlite3", "node-pty", "ws", "selfsigned"],
  });
}, 60_000);
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

beforeEach(() => {
  home = path.join(workDir, `home-${Math.random().toString(36).slice(2)}`);
  outside = path.join(workDir, `outside-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(home);
  fs.mkdirSync(outside);
  // Container mode for the client; the wrapper below stands in for setpriv.
  vi.stubEnv("AC_CORE_HOME", home);
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
});
afterEach(() => vi.unstubAllEnvs());

/** What `asCore` hands a child, minus the privilege switch: a clean env and core's home. */
function options(): CoreHomeOpsOptions {
  return {
    helperPath: bundle,
    wrap: (spec) => ({ ...spec, args: spec.args as string[], cwd: home, env: { HOME: home, PATH: process.env.PATH ?? "" } }),
  };
}

function runBundle(input: string, env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH ?? "" }) {
  return spawnSync(process.execPath, [bundle], { input, env, encoding: "utf8" });
}

describe("the helper bundle as a process", () => {
  it("does a sync operation end to end through the client", () => {
    coreHomeOpSync({ op: "ensureClaudeShiftEnterBinding" }, options());
    expect(JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"))).toEqual({
      shiftEnterKeyBindingInstalled: true,
    });
  });

  it("does an async operation end to end through the client", async () => {
    fs.mkdirSync(path.join(home, "repos"));
    const listing = await coreHomeOp({ op: "dirList", path: null }, options());
    expect(listing.path).toBe(home);
    expect(listing.entries.map((e) => e.name)).toEqual(["repos"]);
  });

  it("answers with exactly one JSON line on stdout", () => {
    fs.mkdirSync(path.join(home, ".claude"));
    const r = runBundle(JSON.stringify({ op: "ensureOrchestrationSkill" }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true });
  });

  it("refuses an unknown operation with exit 2 and the reason on stderr", () => {
    const r = runBundle(JSON.stringify({ op: "deleteEverything" }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refused (unknown-op)");
  });

  it("surfaces a refusal to the daemon as CoreHomeOpRefusedError, with nothing written", async () => {
    await expect(coreHomeOp({ op: "ensureStatuslineTap", cwd: outside }, options())).rejects.toThrow(CoreHomeOpRefusedError);
    await expect(coreHomeOp({ op: "ensureStatuslineTap", cwd: outside }, options())).rejects.toMatchObject({ code: "path-escape" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("does not follow a symlink out of the home", async () => {
    fs.symlinkSync(outside, path.join(home, "link"));
    await expect(
      coreHomeOp({ op: "installHarnessHooks", harness: "claude-code", cwd: path.join(home, "link"), piAgentDir: null }, options()),
    ).rejects.toMatchObject({ code: "path-escape" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("surfaces an operation failure with the operator's sentence", async () => {
    await expect(coreHomeOp({ op: "dirList", path: path.join(home, "nope") }, options())).rejects.toThrow(
      new CoreHomeOpFailedError("Folder not found"),
    );
  });

  it("refuses to run when it is started with the daemon's environment", () => {
    const r = runBundle(JSON.stringify({ op: "dirList", path: null }), {
      HOME: home,
      PATH: process.env.PATH ?? "",
      AC_USER_DATA_DIR: "/var/lib/actana/data",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refusing to run with the daemon's environment (AC_USER_DATA_DIR)");
    expect(r.stdout).not.toContain('"ok":true');
  });
});
