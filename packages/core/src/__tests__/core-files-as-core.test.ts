// The Files API runs as `core`, not as the daemon (issue 557, ADR 0041 D25).
//
// The routes are mounted the way the container mounts them: the daemon and `core` are
// different users (`AC_CORE_*` set), so the daemon's HTTP layer must not touch `~` at all
// and every operation goes through `asCore` to the real helper bundle, run here as a real
// child process. Nothing can `setpriv` in a test, so the launch wrapper records the argv
// the real `asCore` builds, to be asserted, and runs the helper with the clean environment
// and `HOME` it would have had.
import * as fs from "node:fs";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreFilesRequestHandler } from "../core-files-routes";
import { asCore } from "../core-identity";
import type { SpawnSpec } from "../core-identity";

let workDir: string;
let bundle: string;
let home: string;
let outside: string;
let server: http.Server;
let base: string;
/** What the real `asCore` built for each helper the daemon started. */
let launches: Array<SpawnSpec & { args: string[] }> = [];

beforeAll(async () => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "core-files-op-")));
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

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(workDir, "home-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(workDir, "outside-")));
  launches = [];
  // Container mode: the daemon and `core` are different users.
  vi.stubEnv("AC_CORE_HOME", home);
  vi.stubEnv("AC_CORE_UID", String(uid));
  vi.stubEnv("AC_CORE_GID", String(gid));

  const routes = createCoreFilesRequestHandler({
    filesPort: { workspaceRoot: () => home },
    helper: {
      helperPath: bundle,
      exists: () => true, // a `setpriv` to build the argv around; it is never run
      wrap: (spec, options) => {
        launches.push(asCore(spec as SpawnSpec & { args: string[] }, options) as SpawnSpec & { args: string[] });
        // What `asCore` hands the child, minus the privilege switch no test can make.
        return { ...spec, args: spec.args as string[], cwd: home, env: { HOME: home, PATH: process.env.PATH ?? "" } };
      },
    },
  });
  server = http.createServer();
  server.on("request", (req, res) => {
    if (!routes.handle(req, res)) res.writeHead(404).end();
  });
  server.on("checkContinue", (req, res) => {
    if (!routes.handleContinue(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

function call(method: string, url: string, body?: Buffer, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${url}`, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const lines = (answer: Answer): Array<Record<string, unknown>> =>
  answer.body
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** Every filesystem entry point the daemon's own process could use on the home. */
function spyOnDaemonFilesystem(): Array<{ fn: string; target: string }> {
  const touched: Array<{ fn: string; target: string }> = [];
  const watch = (owner: object, fn: string): void => {
    const original = (owner as Record<string, (...args: unknown[]) => unknown>)[fn]!;
    vi.spyOn(owner as Record<string, (...args: unknown[]) => unknown>, fn).mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === "string") touched.push({ fn, target: args[0] });
      return original.apply(this, args);
    });
  };
  for (const fn of ["stat", "lstat", "open", "readdir", "mkdir", "rm", "rename", "realpath", "chmod", "utimes", "opendir", "readFile", "writeFile"]) {
    watch(nodeFs.promises, fn);
  }
  for (const fn of ["createReadStream", "createWriteStream", "realpathSync", "statSync", "lstatSync", "readdirSync", "mkdirSync"]) {
    watch(nodeFs, fn);
  }
  // The named exports other modules import are copies until this republishes them.
  syncBuiltinESMExports();
  return touched;
}

describe("the Files API as core: list and download", () => {
  it("lists the home through the helper, and the daemon's own process never opens a path in it", async () => {
    fs.mkdirSync(path.join(home, "shared"));
    fs.writeFileSync(path.join(home, "shared", "report.md"), "# done\n");
    fs.writeFileSync(path.join(home, "notes.txt"), "hello");
    const touched = spyOnDaemonFilesystem();

    const answer = await call("GET", "/v1/files/list?path=");

    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("application/x-ndjson");
    const entries = lines(answer).filter((line) => line.type === "entry").map((line) => line.path);
    expect(entries.sort()).toEqual(["notes.txt", "shared", "shared/report.md"]);
    expect(lines(answer).at(-1)).toMatchObject({ type: "done", entries: 3 });
    expect(touched.filter((t) => t.target.startsWith(home))).toEqual([]);
  });

  it("downloads a file and a folder (as a tar) through the helper", async () => {
    fs.mkdirSync(path.join(home, "shared"));
    fs.writeFileSync(path.join(home, "shared", "report.md"), "# done\n");

    const file = await call("GET", "/v1/files?path=shared/report.md");
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/octet-stream");
    expect(file.headers["content-length"]).toBe("7");
    expect(file.body.toString("utf8")).toBe("# done\n");

    const folder = await call("GET", "/v1/files?path=shared");
    expect(folder.status).toBe(200);
    expect(folder.headers["content-type"]).toBe("application/x-tar");
    expect(folder.body.subarray(257, 262).toString("ascii")).toBe("ustar");

    const head = await call("HEAD", "/v1/files?path=shared/report.md");
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe("7");
    expect(head.body.length).toBe(0);
  });

  it("starts every helper through asCore: setpriv to core's ids, groups cleared, no new privileges", async () => {
    fs.writeFileSync(path.join(home, "a.txt"), "a");
    await call("GET", "/v1/files?path=a.txt");

    expect(launches).toHaveLength(1);
    const launch = launches[0]!;
    expect(launch.command).toMatch(/setpriv$/);
    expect(launch.args).toEqual(
      expect.arrayContaining([`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs"]),
    );
    expect(launch.args).toContain(process.execPath);
    expect(launch.args).toContain(bundle);
  });

  it("answers a refusal the helper makes with the same status and code as ever", async () => {
    const missing = await call("GET", "/v1/files?path=missing.txt");
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body.toString("utf8"))).toMatchObject({ code: "not-found" });
  });

  it("answers 500 and names no path when the helper cannot be started", async () => {
    const routes = createCoreFilesRequestHandler({
      filesPort: { workspaceRoot: () => home },
      helper: { helperPath: path.join(workDir, "no-such-helper.cjs"), exists: () => true, wrap: (spec) => ({ ...spec, args: spec.args as string[], env: {} }) },
    });
    const broken = http.createServer((req, res) => void routes.handle(req, res));
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    const address = broken.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1/files?path=a.txt`;
    const status = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(url, { agent: false }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }).on("error", reject);
    });
    await new Promise<void>((resolve) => broken.close(() => resolve()));
    expect(status.status).toBe(500);
    expect(JSON.parse(status.body).code).toBe("write-failed");
    expect(status.body).not.toContain(workDir);
  });
});
