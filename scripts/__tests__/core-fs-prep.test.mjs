import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { repoRoot } from "../lib/panel-image.mjs";

const PREP = path.join(repoRoot, "deploy/core-fs-prep.sh");

/**
 * Run the production prep script. The script hard-codes /home/core, so tests
 * that need a temp tree use a tiny extracted copy with CORE_HOME rewritten —
 * proving the *shipped* script ignores CORE_HOME / PATH is a separate case.
 */
function runShippedPrep(env = {}) {
  return spawnSync("sh", [PREP], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** The state mount point `runPrepAt` stands in for /var/lib/actana: beside the home. */
const stateFor = (home) => path.join(path.dirname(home), "state");

function runPrepAt(home, env = {}) {
  const script = fs
    .readFileSync(PREP, "utf8")
    .replaceAll("/home/core", home)
    .replaceAll("/var/lib/actana", stateFor(home))
    .replaceAll("CORE_UID=1000", `CORE_UID=${process.getuid()}`)
    .replaceAll("CORE_GID=1000", `CORE_GID=${process.getgid()}`)
    // The state directory's owner is the runner too: chown to a uid the runner
    // is not fails (EPERM) for anyone but root, and CI is not uid 1000.
    .replaceAll("STATE_UID=1001", `STATE_UID=${process.getuid()}`)
    .replaceAll("STATE_GID=1001", `STATE_GID=${process.getgid()}`);
  const tmp = path.join(home, ".prep-test.sh");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(tmp, script, { mode: 0o755 });
  return spawnSync("sh", [tmp], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Hostile values the shipped script must ignore; the rewritten copy still
      // pins PATH and uses hard-coded (rewritten) paths, not these.
      CORE_HOME: "/etc",
      CORE_USER: "attacker",
      CORE_UID: "0",
      CORE_GID: "0",
      PATH: `/tmp/does-not-exist:${env.PATH ?? process.env.PATH}`,
      ...env,
    },
  });
}

describe("core-fs-prep.sh", () => {
  it("pins PATH and hard-codes /home/core in the shipped script", () => {
    const text = fs.readFileSync(PREP, "utf8");
    expect(text).toContain("PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    expect(text).toContain("CORE_HOME=/home/core");
    expect(text).not.toMatch(/CORE_HOME=\$\{/);
    expect(text).not.toMatch(/CORE_UID=\$\{/);
    expect(fs.existsSync(path.join(repoRoot, "deploy/core-fs-prep-wrap.c"))).toBe(false);
  });

  // #559 — the state volume belongs to `actana`, not to `core`: the one
  // property the whole privilege model rests on. The rewritten copy the other
  // tests run replaces these numbers with the runner's, so the shipped values
  // are read from the shipped text here.
  it("hands the state mount point to actana (1001:1001) and the home to core (1000:1000)", () => {
    const text = fs.readFileSync(PREP, "utf8");
    expect(text).toMatch(/^CORE_UID=1000$/m);
    expect(text).toMatch(/^CORE_GID=1000$/m);
    expect(text).toMatch(/^STATE_UID=1001$/m);
    expect(text).toMatch(/^STATE_GID=1001$/m);
    expect(text).toContain('fix_mount_point "$STATE" hard "$STATE_UID" "$STATE_GID" 0700');
  });

  it("creates shared and repos under a fresh home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
    const home = path.join(root, "home");
    const result = runPrepAt(home);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.statSync(path.join(home, "shared")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(home, "repos")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(home, ".local"))).toBe(false);
  });

  it("fails hard when .local would have been walked — home/shared/repos only", () => {
    // The new script never touches .local; plant a symlink there and prove
    // prep still only operates on home/shared/repos mount points.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
    const home = path.join(root, "home");
    const evil = path.join(root, "evil-usr");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(evil, { recursive: true });
    fs.symlinkSync(evil, path.join(home, ".local"));
    fs.symlinkSync(evil, path.join(home, ".config"));

    const before = fs.readdirSync(evil);
    runPrepAt(home);
    expect(fs.readdirSync(evil)).toEqual(before);
    expect(fs.existsSync(path.join(evil, "bin"))).toBe(false);
    expect(fs.existsSync(path.join(evil, "share"))).toBe(false);
    expect(fs.existsSync(path.join(evil, "actana"))).toBe(false);
  });

  it("fails hard when shared is a symlink out of home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
    const home = path.join(root, "home");
    const evil = path.join(root, "evil-shared");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(evil, { recursive: true });
    fs.symlinkSync(evil, path.join(home, "shared"));

    const before = fs.readdirSync(evil);
    const result = runPrepAt(home);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/symlink|refusing/i);
    expect(fs.readdirSync(evil)).toEqual(before);
  });

  it("warns and continues when repos is a symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
    const home = path.join(root, "home");
    const evil = path.join(root, "evil-repos");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(evil, { recursive: true });
    fs.symlinkSync(evil, path.join(home, "repos"));

    const result = runPrepAt(home);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/warning:.*repos/i);
    expect(fs.lstatSync(path.join(home, "repos")).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(evil)).toEqual([]);
  });

  it("ignores CORE_HOME and a hostile PATH in the shipped script", () => {
    // Running against real /home/core may not be writable here; we only assert
    // the script does not consult the hostile env when deciding PATH/binaries.
    // A dry parse: the first lines must assign PATH before any command.
    const text = fs.readFileSync(PREP, "utf8");
    const pathLine = text.indexOf("PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    const firstStat = text.search(/^\s*owner=\$\(stat /m);
    const firstChown = text.search(/^\s*(if ! )?chown /m);
    expect(pathLine).toBeGreaterThan(0);
    expect(firstStat).toBeGreaterThan(pathLine);
    expect(firstChown).toBeGreaterThan(pathLine);

    const result = runShippedPrep({
      CORE_HOME: "/etc",
      CORE_UID: "0",
      PATH: "/tmp/hostile-bin:/usr/bin",
    });
    // Whatever the exit code (often fail without root on /home/core), it must
    // not have taken CORE_HOME=/etc as the repair root.
    expect(result.stderr + result.stdout).not.toMatch(/chown.*\/etc[^\w]/);
  });

  // #559 — the daemon's state mount point is prepared like the home's, with
  // its own owner and a mode that is never looser than 0700.
  describe("the state mount point", () => {
    it("is created 0700 when it is missing", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
      const home = path.join(root, "home");
      const result = runPrepAt(home);
      expect(result.status, result.stderr).toBe(0);
      const state = fs.statSync(stateFor(home));
      expect(state.isDirectory()).toBe(true);
      expect(state.mode & 0o777).toBe(0o700);
    });

    it("fails hard, on stderr, when the state mount point is a file", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
      const home = path.join(root, "home");
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(stateFor(home), "not a directory");
      const result = runPrepAt(home);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/core-fs-prep: error: .*state is not a directory/);
    });

    // A regression guard, not a test of the change: the old prep never looked
    // at the state directory, so this passes there too.
    it("regression guard: leaves the mode and contents of an existing one alone", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
      const home = path.join(root, "home");
      fs.mkdirSync(path.join(stateFor(home), "data"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(stateFor(home), "data", "missioncontrol.db"), "x");
      const result = runPrepAt(home);
      expect(result.status, result.stderr).toBe(0);
      expect(fs.statSync(stateFor(home)).mode & 0o777).toBe(0o700);
      expect(fs.readFileSync(path.join(stateFor(home), "data", "missioncontrol.db"), "utf8")).toBe("x");
    });

    it("fails hard, on stderr, when the state mount point is a symlink", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
      const home = path.join(root, "home");
      const evil = path.join(root, "evil-state");
      fs.mkdirSync(evil, { recursive: true });
      fs.symlinkSync(evil, stateFor(home));
      const before = fs.readdirSync(evil);
      const result = runPrepAt(home);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/core-fs-prep: error: .*state.*symlink/);
      expect(fs.readdirSync(evil)).toEqual(before);
    });
  });
});
