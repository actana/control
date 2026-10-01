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
import { WorkspaceWriteLocks } from "../files-transfer-locks";
import { packDirectory } from "../files-tar";
import { cleanupTrees, collect, makeTree } from "./files-fixture";
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
let locks: WorkspaceWriteLocks;
/** The pids the daemon asked `killAsCore` to signal, and the argv it would have used to do so as core. */
let kills: Array<{ pid: number; args: string[] }> = [];

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
  locks = new WorkspaceWriteLocks();
  kills = [];
  // Container mode: the daemon and `core` are different users.
  vi.stubEnv("AC_CORE_HOME", home);
  vi.stubEnv("AC_CORE_UID", String(uid));
  vi.stubEnv("AC_CORE_GID", String(gid));

  const routes = createCoreFilesRequestHandler({
    filesPort: { workspaceRoot: () => home },
    locks,
    helper: {
      helperPath: bundle,
      exists: () => true, // a `setpriv` to build the argv around; it is never run
      // The daemon has no CAP_KILL on another uid, so it signals through `killAsCore`. Here the
      // signal is delivered directly, and the pid it was asked for is recorded.
      killOptions: {
        exists: () => true,
        run: async (spec) => {
          const pid = Number(spec.args.at(-1));
          kills.push({ pid, args: spec.args });
          process.kill(pid, "SIGKILL");
          return { status: 0 };
        },
      },
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
  cleanupTrees();
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

describe("the Files API as core: upload and tar", () => {
  it("writes a single file as core, with its mode, and reports the five fields", async () => {
    const touched = spyOnDaemonFilesystem();

    const answer = await call("PUT", "/v1/files?path=shared/run.sh", Buffer.from("#!/bin/sh\n"), {
      "x-actana-file-mode": "493",
    });

    expect(answer.status).toBe(200);
    expect(lines(answer)).toEqual([
      expect.objectContaining({ type: "entry", path: "shared/run.sh", kind: "file", size: 10, mode: 0o755, result: "written" }),
      { type: "done", entries: 1, bytes: 10 },
    ]);
    expect(fs.readFileSync(path.join(home, "shared", "run.sh"), "utf8")).toBe("#!/bin/sh\n");
    expect(touched.filter((t) => t.target.startsWith(home))).toEqual([]);
  });

  it("creates files and folders owned by core, the user the helper was started as", async () => {
    const tar = await collect(packDirectory(makeTree({ "inner/deep/leaf.txt": "leaf" })));

    await call("PUT", "/v1/files?path=drop.txt", Buffer.from("x"));
    await call("PUT", "/v1/files?path=dropped", tar, { "content-type": "application/x-tar" });

    // The helper is started as `core`, and `core` is `AC_CORE_UID` (here the test's own, the
    // only one a test can be). Every node it made carries that id, and none is root's.
    for (const created of ["drop.txt", "dropped", "dropped/inner", "dropped/inner/deep/leaf.txt"]) {
      expect(fs.lstatSync(path.join(home, created)).uid, created).toBe(uid);
    }
    expect(launches).toHaveLength(2);
    for (const launch of launches) expect(launch.args).toContain(`--reuid=${uid}`);
  });

  it("unpacks a tar into a folder and keeps its tree", async () => {
    const tar = await collect(
      packDirectory(makeTree({ "a/b/c.txt": "c", "a/d.txt": "d", "e.txt": { content: "#!/bin/sh\n", mode: 0o755 }, "empty/": "" })),
    );

    const answer = await call("PUT", "/v1/files?path=shared/drop", tar, { "content-type": "application/x-tar" });

    expect(answer.status).toBe(200);
    expect(lines(answer).at(-1)).toMatchObject({ type: "done" });
    expect(lines(answer).filter((l) => l.type === "entry").map((l) => l.path)).toEqual(
      expect.arrayContaining(["shared/drop/a/b/c.txt", "shared/drop/a/d.txt", "shared/drop/e.txt"]),
    );
    expect(fs.readFileSync(path.join(home, "shared", "drop", "a", "b", "c.txt"), "utf8")).toBe("c");
    expect(fs.statSync(path.join(home, "shared", "drop", "e.txt")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(home, "shared", "drop", "empty")).isDirectory()).toBe(true);
  });

  it("refuses a single-file write at the home itself, from the helper, and writes nothing", async () => {
    const answer = await call("PUT", "/v1/files?path=", Buffer.from("x"));

    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body.toString("utf8")).code).toBe("malformed-path");
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("refuses a second write while one holds the lease, without starting a helper for it", async () => {
    locks.acquire("shared/big");

    const answer = await call("PUT", "/v1/files?path=other.txt", Buffer.from("x"));

    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body.toString("utf8")).code).toBe("transfer-in-progress");
    expect(launches).toHaveLength(0);
    expect(fs.existsSync(path.join(home, "other.txt"))).toBe(false);
  });

  it("stops the helper and frees the lease when the client hangs up mid-upload", async () => {
    const req = http.request(`${base}/v1/files?path=partial.bin`, { method: "PUT", agent: false });
    req.on("error", () => undefined);
    req.write(Buffer.alloc(64 * 1024, 1));
    await vi.waitFor(() => expect(locks.current()?.path).toBe("partial.bin"), { timeout: 5_000 });

    req.destroy();
    await vi.waitFor(() => expect(locks.current()).toBeNull(), { timeout: 5_000 });

    // The helper itself was stopped, as core, and is gone: freeing the lease alone would leave it
    // alive on stdin for as long as the daemon runs.
    await vi.waitFor(() => expect(kills).toHaveLength(1), { timeout: 5_000 });
    expect(kills[0]!.args).toEqual(expect.arrayContaining(["--reuid=" + uid, "KILL", String(kills[0]!.pid)]));
    await vi.waitFor(
      () => expect(() => process.kill(kills[0]!.pid, 0)).toThrow(/ESRCH/),
      { timeout: 5_000 },
    );

    const after = await call("PUT", "/v1/files?path=after.txt", Buffer.from("fine"));
    expect(after.status).toBe(200);
    expect(fs.readFileSync(path.join(home, "after.txt"), "utf8")).toBe("fine");
  });
});
