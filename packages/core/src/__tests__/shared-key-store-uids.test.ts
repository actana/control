// The key is unreadable by `core`, with two real users and the kernel's own answer (#562,
// ADR 0041 D24, D33). The daemon is `actana` (uid 1001) and owns a 0700 state directory;
// the Sessions' user is `core` (uid 1000). The test writes the key as 1001 with the real
// sync code, then tries to read it as 1000, and also searches everything 1000 can open
// for the key.
//
// It needs real root to become two users, so under the plain `Unit Tests` step it is
// SKIPPED. CI's "Shared-folder key is unreadable by core" step runs it under `sudo` with
// ACTANA_REQUIRE_ROOT_TESTS=1, and with that set a missing root or setpriv FAILS instead
// of skipping, so the step cannot go green without it. The same pattern as `asCore for
// real` in `packages/shared/src/__tests__/core-home.test.ts`.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const isRoot = process.platform === "linux" && process.getuid?.() === 0;
const SETPRIV = ["/usr/bin/setpriv", "/bin/setpriv"].find((f) => fs.existsSync(f));
const required = process.env.ACTANA_REQUIRE_ROOT_TESTS === "1";

const ACTANA = { uid: 1001, gid: 1001 };
const CORE = { uid: 1000, gid: 1000 };
const SECRET = "SECRET-ACCESS-KEY-FOR-THE-UID-TEST";
const TOKEN = "SESSION-TOKEN-FOR-THE-UID-TEST";

describe.runIf(required)("the uid step has what it needs", () => {
  it("is root on Linux with setpriv installed", () => {
    expect(process.platform).toBe("linux");
    expect(process.getuid?.()).toBe(0);
    expect(SETPRIV).toBeDefined();
  });
});

describe.skipIf(!isRoot || !SETPRIV)("the Shared folder's key, as two users", () => {
  let root: string;
  let stateDir: string;
  let homeDir: string;
  let writer: string;

  const as = (who: { uid: number; gid: number }, command: string, args: string[]) =>
    spawnSync(
      SETPRIV!,
      [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", command, ...args],
      { encoding: "utf8" },
    );

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shared-key-uids-")));
    fs.chmodSync(root, 0o755);
    stateDir = path.join(root, "state");
    homeDir = path.join(root, "home");
    // The container's layout: the daemon's state is its own and 0700; core's home is core's.
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.chownSync(stateDir, ACTANA.uid, ACTANA.gid);
    fs.mkdirSync(path.join(homeDir, "shared"), { recursive: true });
    fs.chownSync(homeDir, CORE.uid, CORE.gid);
    fs.chownSync(path.join(homeDir, "shared"), CORE.uid, CORE.gid);

    // The real attach, as the daemon: the key store and the sync, bundled, run as 1001.
    writer = path.join(root, "writer.cjs");
    await build({
      stdin: {
        contents: `
          const { createSharedSync } = require(${JSON.stringify(path.resolve(__dirname, "../shared-sync.ts"))});
          const sync = createSharedSync({
            stateDir: process.argv[2],
            home: { list: async () => ({ files: [], unreadable: [] }), stat: async () => null, read: async () => Buffer.alloc(0), write: async () => ({ size: 0, mtime: 0 }), remove: async () => {} },
            createShared: () => ({ list: async () => [], watch: async () => ({ changes: [], cursor: "" }), get: async () => { throw new Error("none"); }, put: async () => {}, rm: async () => {} }),
          });
          sync.handle({
            type: "sharedAttach", reqId: "r", endpoint: "http://s3.test", bucket: "b", prefix: "cores/core-a", region: "us-east-1",
            credentials: { accessKeyId: "AKIA-UID-TEST", secretAccessKey: ${JSON.stringify(SECRET)}, sessionToken: ${JSON.stringify(TOKEN)} },
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          }).then(async (status) => { await sync.idle(); sync.stop(); console.log(JSON.stringify(status)); });
        `,
        resolveDir: __dirname,
      },
      outfile: writer,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      logLevel: "silent",
      external: ["better-sqlite3", "node-pty", "ws", "selfsigned"],
    });
    fs.chmodSync(writer, 0o755);
  }, 60_000);

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("the daemon (1001) stores the key, and can read it back", () => {
    const run = as(ACTANA, process.execPath, [writer, stateDir]);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim().split("\n").at(-1)!)).toMatchObject({ state: "attached" });
    const keyFile = path.join(stateDir, "shared-key.json");
    const own = as(ACTANA, "/bin/cat", [keyFile]);
    expect(own.status, own.stderr).toBe(0);
    expect(own.stdout).toContain(SECRET);
    expect(fs.statSync(keyFile).uid).toBe(ACTANA.uid);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it("core (1000) cannot read the key file, list its directory, or reach it any other way", () => {
    const keyFile = path.join(stateDir, "shared-key.json");
    const read = as(CORE, "/bin/cat", [keyFile]);
    expect(read.status).not.toBe(0);
    expect(read.stderr).toMatch(/Permission denied/);
    expect(read.stdout).not.toContain(SECRET);
    const list = as(CORE, "/bin/ls", [stateDir]);
    expect(list.status).not.toBe(0);
    expect(list.stderr).toMatch(/Permission denied/);
    // Not by a hard link, a copy or a search of the whole tree either.
    const copy = as(CORE, "/bin/cp", [keyFile, path.join(homeDir, "stolen")]);
    expect(copy.status).not.toBe(0);
    // (The test's own writer script names the key, so it is the state and the home that are searched.)
    const search = as(CORE, "/bin/grep", ["-rl", SECRET, stateDir, homeDir]);
    expect(search.stdout.trim()).toBe("");
    expect(search.stderr).toMatch(/Permission denied/);
  });

  it("core's home holds no key, and the state directory is 0700 with the key in it alone", () => {
    expect(spawnSync("/bin/grep", ["-rl", SECRET, homeDir], { encoding: "utf8" }).stdout.trim()).toBe("");
    expect(spawnSync("/bin/grep", ["-rl", TOKEN, homeDir], { encoding: "utf8" }).stdout.trim()).toBe("");
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
    const holders = spawnSync("/bin/grep", ["-rl", SECRET, stateDir], { encoding: "utf8" }).stdout.trim().split("\n");
    expect(holders).toEqual([path.join(stateDir, "shared-key.json")]);
  });
});
