// The Shared folder's sync in the container's shape: the daemon and `core` are different
// users (`AC_CORE_*` set), so the daemon may not open a path in `~` and everything in
// `~/shared` is done by the real Files helper bundle, started through `asCore`, as a real
// child process (#562, ADR 0041 D33). Nothing can `setpriv` in a test, so the launch
// wrapper records the argv the real `asCore` builds and runs the helper with the clean
// environment and `HOME` it would have had.
import * as fs from "node:fs";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreLinkRequestFrame } from "@actana/sdk/core";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asCore, type SpawnSpec } from "../core-identity";
import { createSharedHome } from "../shared-home-io";
import { createSharedKeyStore } from "../shared-key-store";
import { createSharedSync, type SharedSync } from "../shared-sync";
import { FakeS3 } from "./shared-s3-fake";

let workDir: string;
let bundle: string;
let home: string;
let stateDir: string;
let launches: Array<SpawnSpec & { args: string[] }>;
let wrapped: Array<SpawnSpec & { args: string[] }>;
let s3: FakeS3;
let sync: SharedSync;
let t: number;

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const T0 = Date.parse("2026-10-01T12:00:00Z");
const SECRET = "SECRET-ACCESS-KEY-VALUE";
const TOKEN = "SESSION-TOKEN-VALUE";
const KEY_ID = "AKIA-CONTAINER-TEST";

beforeAll(async () => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shared-sync-as-core-")));
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
  home = fs.realpathSync(fs.mkdtempSync(path.join(workDir, "home-")));
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(workDir, "state-")));
  fs.chmodSync(stateDir, 0o700);
  fs.mkdirSync(path.join(home, "shared"));
  launches = [];
  wrapped = [];
  t = T0;
  vi.stubEnv("AC_CORE_HOME", home);
  vi.stubEnv("AC_CORE_UID", String(uid));
  vi.stubEnv("AC_CORE_GID", String(gid));
  s3 = new FakeS3();
  s3.clock = () => t;
  s3.issue({ accessKeyId: KEY_ID, sessionToken: TOKEN, prefix: "cores/core-a", expiresAt: T0 + 3_600_000 });
  sync = createSharedSync({
    stateDir,
    home: createSharedHome({
      home,
      helperPath: bundle,
      exists: () => true,
      wrap: (spec, options) => {
        launches.push(asCore(spec as SpawnSpec & { args: string[] }, options) as SpawnSpec & { args: string[] });
        const run = { ...spec, args: spec.args as string[], cwd: home, env: { HOME: home, PATH: process.env.PATH ?? "" } };
        wrapped.push(run);
        return run;
      },
    }),
    now: () => t,
    fetch: s3.fetch,
    intervalMs: 3_600_000,
  });
});

afterEach(() => {
  sync.stop();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

const attachFrame: CoreLinkRequestFrame = {
  type: "sharedAttach",
  reqId: "r",
  endpoint: "http://s3.test",
  bucket: "actana-shared",
  prefix: "cores/core-a",
  region: "us-east-1",
  credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET, sessionToken: TOKEN },
  expiresAt: new Date(T0 + 3_600_000).toISOString(),
};

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
  for (const fn of ["createReadStream", "createWriteStream", "realpathSync", "statSync", "lstatSync", "readdirSync", "mkdirSync", "readFileSync", "writeFileSync"]) {
    watch(nodeFs, fn);
  }
  syncBuiltinESMExports();
  return touched;
}

describe("the sync as the container runs it", () => {
  it("syncs both ways through the helper, and the daemon never opens a path in the home", async () => {
    fs.writeFileSync(path.join(home, "shared", "up.txt"), "going up");
    s3.seed("cores/core-a/down.txt", "coming down", T0 - 1_000);
    const touched = spyOnDaemonFilesystem();

    expect(await sync.handle(attachFrame)).toMatchObject({ state: "attached" });
    await sync.idle();
    // What the daemon's process opened while syncing, before this test looks at the folder itself.
    const opened = touched.filter((entry) => entry.target.startsWith(home));

    expect(s3.text("cores/core-a/up.txt")).toBe("going up");
    expect(fs.readFileSync(path.join(home, "shared", "down.txt"), "utf8")).toBe("coming down");
    expect(launches.length).toBeGreaterThan(0);
    expect(opened).toEqual([]);
  });

  it("starts every helper through asCore, and gives it no key: not in the argv, not in the environment", async () => {
    fs.writeFileSync(path.join(home, "shared", "up.txt"), "x");
    await sync.handle(attachFrame);
    await sync.idle();

    expect(launches.length).toBeGreaterThan(0);
    for (const launch of launches) {
      expect(launch.command).toMatch(/setpriv$/);
      expect(launch.args).toEqual(expect.arrayContaining([`--reuid=${uid}`, `--regid=${gid}`, "--no-new-privs", bundle]));
    }
    for (const spec of [...launches, ...wrapped]) {
      const text = JSON.stringify(spec);
      for (const secret of [SECRET, TOKEN, KEY_ID, createSharedKeyStore(stateDir).path]) expect(text).not.toContain(secret);
    }
  });

  it("keeps the key in the state directory only, and never in the home", async () => {
    await sync.handle(attachFrame);
    await sync.idle();
    const holders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.readFileSync(full, "utf8").includes(SECRET)) holders.push(full);
      }
    };
    walk(home);
    walk(stateDir);
    expect(holders).toEqual([createSharedKeyStore(stateDir).path]);
    expect(fs.statSync(createSharedKeyStore(stateDir).path).mode & 0o777).toBe(0o600);
  });

  it("refuses to follow a link that leaves the home, through the helper's own confinement", async () => {
    const outside = path.join(workDir, `outside-${path.basename(home)}`);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "x.txt"), "OUTSIDE");
    // A link in the folder that the helper would follow if it were a path to read or write.
    fs.symlinkSync(outside, path.join(home, "shared", "escape"));
    s3.seed("cores/core-a/escape/planted.txt", "must not land outside", T0 - 1_000);
    await sync.handle(attachFrame);
    await sync.idle();
    expect(fs.readdirSync(outside)).toEqual(["x.txt"]);
    expect([...s3.objects.values()].map((o) => new TextDecoder().decode(o.bytes))).not.toContain("OUTSIDE");
  });

  it("never logs the key, whatever happens to the pass", async () => {
    const output: string[] = [];
    for (const method of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(" ")));
    }
    await sync.handle(attachFrame);
    await sync.idle();
    t += 2 * 3_600_000;
    fs.writeFileSync(path.join(home, "shared", "late.txt"), "x");
    await sync.pass(); // expired
    s3.keys.clear(); // and now the store refuses the key
    await sync.handle({ ...attachFrame, type: "sharedCredentials", expiresAt: new Date(t + 3_600_000).toISOString() });
    await sync.idle();
    for (const secret of [SECRET, TOKEN]) expect(output.join("\n")).not.toContain(secret);
  });
});
