// The Files API helper bundle as a real child process (issue 557, ADR 0041 D25).
//
// `core-files-as-core.test.ts` drives it through the daemon's side. This feeds it by hand, so
// what the daemon relies on is pinned at the process boundary: the exit status it reads first,
// stdout (the head line and then the body) and stderr, which is for a person reading the logs.
// It cannot `setpriv` (no root here), so `HOME` and a clean environment stand in for what
// `asCore` builds.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let workDir: string;
let bundle: string;
let home: string;
let outside: string;

beforeAll(async () => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "core-files-op-process-")));
  bundle = path.join(workDir, "core-files-op.cjs");
  await build({
    entryPoints: [path.resolve(__dirname, "../core-files-op-entry.ts")],
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
  home = fs.mkdtempSync(path.join(workDir, "home-"));
  outside = fs.mkdtempSync(path.join(workDir, "outside-"));
  fs.writeFileSync(path.join(outside, "precious.txt"), "keep me");
});

const cleanEnv = (): NodeJS.ProcessEnv => ({ HOME: home, PATH: process.env.PATH ?? "" });

function run(input: string | Buffer, env: NodeJS.ProcessEnv = cleanEnv()) {
  const r = spawnSync(process.execPath, [bundle], { input, env });
  const stdout = r.stdout.toString("utf8");
  const newline = stdout.indexOf("\n");
  return {
    status: r.status,
    stderr: r.stderr.toString("utf8"),
    stdout,
    head: newline >= 0 ? (JSON.parse(stdout.slice(0, newline)) as { status: number; headers: Record<string, string> }) : null,
    body: newline >= 0 ? stdout.slice(newline + 1) : "",
  };
}

const request = (value: unknown, body = ""): Buffer => Buffer.from(`${JSON.stringify(value)}\n${body}`);

describe("the Files API helper as a process", () => {
  it("answers a read as a head line, then the bytes, and exits 0 with nothing on stderr", () => {
    fs.writeFileSync(path.join(home, "a.txt"), "hello");

    const r = run(request({ op: "read", path: "a.txt", headOnly: false }));

    expect(r.status).toBe(0);
    expect(r.head).toMatchObject({ status: 200, headers: { "content-length": "5", "x-actana-transfer-kind": "file" } });
    expect(r.body).toBe("hello");
    expect(r.stderr).toBe("");
  });

  it("writes the body that follows the request line, and reports it", () => {
    const r = run(request({ op: "write", path: "shared/n.txt", tar: false, contentLength: null, fileMode: null, fileMtime: null }, "payload"));

    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(home, "shared", "n.txt"), "utf8")).toBe("payload");
    expect(r.body).toContain('"path":"shared/n.txt"');
  });

  it("answers a path outside the home as a 400 head with exit 0, and touches nothing", () => {
    const r = run(request({ op: "delete", path: "../outside/precious.txt" }));

    expect(r.status).toBe(0); // a refusal is a complete answer; the daemon relays the 400
    expect(r.head?.status).toBe(400);
    expect(JSON.parse(r.body)).toMatchObject({ code: "dot-dot-segment" });
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("keep me");
  });

  it("takes its root from HOME and from nothing a request says", () => {
    // The request names a root of its own; it is not a field of any request and is dropped, so
    // the read is still of the home, which has no such file.
    const r = run(request({ op: "read", path: "precious.txt", headOnly: false, root: outside, home: outside }));

    expect(r.status).toBe(0);
    expect(r.head?.status).toBe(404);
    expect(r.body).not.toContain("keep me");
  });

  it("refuses to start with a variable of the daemon's in its environment: exit 2, the reason on stderr, no head", () => {
    const r = run(request({ op: "read", path: "a.txt", headOnly: false }), { ...cleanEnv(), AC_STATE_DIR: "/var/lib/actana" });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain("core-files-op: refused: refusing to run with the daemon's environment (AC_STATE_DIR)");
    expect(r.stdout).toBe("");
  });

  it("lets AC_HOOK_ variables through: they are what a Session reads back, not the daemon's", () => {
    fs.writeFileSync(path.join(home, "a.txt"), "x");
    const r = run(request({ op: "read", path: "a.txt", headOnly: true }), { ...cleanEnv(), AC_HOOK_URL: "http://127.0.0.1:1" });

    expect(r.status).toBe(0);
  });

  it("refuses a HOME that is not an absolute path: exit 2, on stderr", () => {
    const r = run(request({ op: "read", path: "a.txt", headOnly: false }), { PATH: process.env.PATH ?? "", HOME: "relative/home" });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain("HOME is not an absolute path");
    expect(r.stdout).toBe("");
  });

  it.each([
    ["not JSON", Buffer.from("this is not json\n")],
    ["no request line at all", Buffer.from("")],
    ["an unknown operation", request({ op: "chmod", path: "a.txt" })],
    ["a path that is not a string", request({ op: "delete", path: 7 })],
    ["a request with no newline", Buffer.from(JSON.stringify({ op: "delete", path: "a.txt" }))],
  ])("refuses %s: exit 2, the reason on stderr, no head, nothing done", (_name, input) => {
    fs.writeFileSync(path.join(home, "a.txt"), "keep");

    const r = run(input);

    expect(r.status).toBe(2);
    expect(r.stderr).toContain("core-files-op: refused:");
    expect(r.stdout).toBe("");
    expect(fs.readFileSync(path.join(home, "a.txt"), "utf8")).toBe("keep");
  });
});
