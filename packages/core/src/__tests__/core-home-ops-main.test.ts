// The helper program's contract with the daemon: exit status, stdout and stderr
// (issue 559, PR 3). A refusal must be loud where an operator reads it (stderr)
// and where the daemon reads it (exit status 2), and it must have done nothing.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCoreHomeOpsMain } from "../core-home-ops-main";

let base: string;
let home: string;
let outside: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "core-home-main-")));
  home = path.join(base, "home");
  outside = path.join(base, "outside");
  fs.mkdirSync(home);
  fs.mkdirSync(outside);
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

async function run(input: string | Buffer, env: NodeJS.ProcessEnv = { HOME: home }) {
  let stdout = "";
  let stderr = "";
  const status = await runCoreHomeOpsMain({
    stdin: Readable.from([input]),
    stdout: { write: (c) => (stdout += c) },
    stderr: { write: (c) => (stderr += c) },
    env,
  });
  return { status, stdout, stderr, answer: stdout.trim() ? JSON.parse(stdout) : null };
}

const execCwd = (p: string | null) => JSON.stringify({ op: "resolveExecCwd", cwd: p });

describe("the helper program", () => {
  it("answers a good request with exit 0 and exactly one JSON line", async () => {
    const r = await run(execCwd(null));
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.answer).toMatchObject({ ok: true, result: { cwd: home } });
    expect(r.stderr).toBe("");
  });

  it("refuses an unknown operation: exit 2, the reason on stderr and in the answer", async () => {
    const r = await run(JSON.stringify({ op: "deleteEverything" }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("core-home-ops: refused (unknown-op)");
    expect(r.answer).toMatchObject({ ok: false, code: "unknown-op" });
  });

  it("refuses a path outside the home: exit 2, stderr names it, nothing is written", async () => {
    const r = await run(JSON.stringify({ op: "ensureStatuslineTap", cwd: outside }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refused (path-escape)");
    expect(r.stderr).toContain(outside);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses a symlink out of the home: exit 2, nothing is written through it", async () => {
    fs.symlinkSync(outside, path.join(home, "link"));
    const r = await run(JSON.stringify({ op: "installHarnessHooks", harness: "claude-code", cwd: path.join(home, "link"), piAgentDir: null }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refused (path-escape)");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.each([
    ["not JSON", "{oops"],
    ["empty", ""],
  ])("refuses a request that is %s", async (_n, text) => {
    const r = await run(text);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refused (bad-json)");
  });

  it("refuses a request over the size cap without parsing it", async () => {
    const r = await run(Buffer.alloc(1024 * 1024 + 1, 0x20));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refused (too-large)");
  });

  it("reports an operation that ran and failed as exit 1, in the operator's words", async () => {
    const r = await run(execCwd(path.join(home, "nope")));
    expect(r.status).toBe(1);
    const message = `No such directory on this Core: ${path.join(home, "nope")}`;
    expect(r.stderr).toContain(`core-home-ops: failed: ${message}`);
    expect(r.answer).toEqual({ ok: false, code: "failed", message });
  });

  it("refuses to start in the daemon's environment, and does no work", async () => {
    for (const name of ["AC_USER_DATA_DIR", "AC_CORE_MATERIAL_FILE", "AC_SECRETS_KEY", "AC_CORE_HOME"]) {
      const r = await run(execCwd(null), { HOME: home, [name]: "x" });
      expect(r.status, name).toBe(2);
      expect(r.stderr, name).toContain(`refusing to run with the daemon's environment (${name})`);
      expect(r.stdout.includes('"ok":true'), name).toBe(false);
    }
  });

  it("lets AC_HOOK_* through: that is what a Session's own hooks read", async () => {
    const r = await run(execCwd(null), { HOME: home, AC_HOOK_URL: "http://127.0.0.1:1" });
    expect(r.status).toBe(0);
  });

  it.each([["missing", undefined], ["relative", "home"]])("refuses when HOME is %s", async (_n, value) => {
    const r = await run(execCwd(null), value === undefined ? {} : { HOME: value });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("HOME is not an absolute path");
  });

  it("confines to its own HOME, not to a root the request names", async () => {
    const r = await run(execCwd(outside), { HOME: home });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Not inside this Core's home");
  });
});
