// `install.sh` is the product's front door, and it runs on machines nobody
// tests on — so it is exercised here as the operator runs it: the real script,
// piped to a real shell, against a server that answers exactly like GitHub
// Releases, with a stub `bin/actana` in the tarball that records what the
// bootstrapper handed it.
//
// What is deliberately NOT here: systemd, a real Core, a real network. The
// container e2e (`scripts/e2e-actana-setup-linux.mjs`) runs the same script
// against a real tarball on a real init system; this file covers the decisions
// the bootstrapper itself makes — platform mapping, version resolution,
// checksum verification, which verb it hands the bundle to, exit codes — in
// under a second, on every platform CI runs.
//
// **Install is not activation** (ADR 0036 C2, #316). The script places the
// bundle and stops: it runs `actana place`, never `actana setup`, and the
// flags it used to forward to setup are refused rather than ignored. Two
// things follow for this file, and they are what the placement block below is
// for. First, "did not run setup" is only half a contract — the other half is
// that something *was* placed, outside the temp directory the EXIT trap
// deletes, or a successful run would leave the machine as it was found.
// Second, the next command is printed by the CLI (which knows the layout) and
// never by the script, so what is asserted here is that the script adds no
// second copy of it.
//
// Platform mapping is tested by putting a `uname` shim first on PATH. It looks
// like a trick and is the opposite: `uname` is precisely the input the script
// reads, so faking it exercises the real branch instead of a parallel copy of
// the mapping table.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_REPO,
  SHASUMS_ASSET,
  startFixtureReleaseServer,
  writeStubRelease,
} from "../lib/fixture-release.mjs";
import { tarballName } from "../lib/core-tarball.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const INSTALL_SH = path.join(repoRoot, "install.sh");

/** The two good releases the fixture serves. `--version` pins the older one. */
const OLD_VERSION = "0.1.0";
const NEW_VERSION = "0.2.0";

/**
 * A deliberately broken third release: it carries `linux-x64` only, and that
 * one asset is served corrupted. Both download failure paths — "this release
 * has no build for my platform" and "checksum mismatch" — pin to it, which
 * leaves the two good releases good and lets every platform-mapping case
 * assert a clean install rather than tolerating a known-bad target.
 */
const BROKEN_VERSION = "0.0.9";

/**
 * Stands in for the tarball's `bin/actana`: prints what it was called with and
 * whether it got a terminal, so the tests can assert both the verb the
 * bootstrapper handed the bundle to and that no run has a TTY to prompt on.
 *
 * It also does the smallest honest version of what `actana place` does — write
 * one file *outside* the script's temp directory. That is the property the
 * whole ticket turns on: before #316 the extracted tree survived only because
 * `actana setup` copied it into the install layout, so a script that stopped
 * calling setup and placed nothing would install nothing at all and still
 * exit 0. The real placement is unit-tested in `packages/cli` and exercised
 * for real by the container e2e; here it only has to be observable.
 */
const stubActana = (version, target) => `#!/bin/sh
printf 'stub-actana version=%s target=%s\\n' '${version}' '${target}'
printf 'args=%s\\n' "$*"
if [ -t 0 ]; then printf 'tty=yes\\n'; else printf 'tty=no\\n'; fi
# Whatever the bootstrapper left on stdin. Empty means it handed over
# /dev/null, which is what stops a piped install being eaten by its own child.
printf 'stdin=%s\\n' "$(cat)"
if [ -n "\${ACTANA_STUB_LOG:-}" ]; then printf '%s\\n' "$*" >> "\${ACTANA_STUB_LOG}"; fi
if [ -n "\${ACTANA_STUB_PLACED:-}" ] && [ "\${ACTANA_STUB_EXIT:-0}" = "0" ]; then
  mkdir -p "$(dirname "\${ACTANA_STUB_PLACED}")"
  printf 'placed by: %s\\n' "$*" > "\${ACTANA_STUB_PLACED}"
fi
# The CLI is the half that knows the layout, so the CLI is the half that
# prints the next command. \`NEXT\` stands in for that line.
printf 'NEXT %s/bin/actana setup\\n' "\${ACTANA_STUB_CURRENT:-/home/op/.local/share/actana/current}"
exit \${ACTANA_STUB_EXIT:-0}
`;

// POSIX sh only — there is no Windows Core, so the installer never runs there.
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

describeOnPosix("install.sh", () => {
  let root;
  let releaseDir;
  let server;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "actana-install-sh-"));
    releaseDir = path.join(root, "releases");

    // Every release target, both good versions: the mapping tests need a real
    // asset to download for each, and the pinning test needs two releases to
    // choose between.
    for (const version of [OLD_VERSION, NEW_VERSION]) {
      for (const target of ["linux-x64", "linux-arm64", "mac-arm64"]) {
        writeStubRelease({ dir: releaseDir, version, target, script: stubActana(version, target) });
      }
    }
    // The broken release: part of a release (linux-x64 alone) whose one asset
    // is also served corrupted.
    writeStubRelease({
      dir: releaseDir,
      version: BROKEN_VERSION,
      target: "linux-x64",
      script: stubActana(BROKEN_VERSION, "linux-x64"),
    });

    server = await startFixtureReleaseServer({
      dir: releaseDir,
      scriptPath: INSTALL_SH,
      corruptAssets: [tarballName(BROKEN_VERSION, "linux-x64")],
    });
  });

  afterAll(async () => {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * A `uname` that reports the machine the test is pretending to run on, and —
   * when `rosetta` is set — a `sysctl` that answers as a translated process
   * does. Rosetta is the one case `uname` alone cannot describe: an
   * Apple-silicon Mac running a translated shell reports `x86_64`, so
   * `sysctl.proc_translated` is what tells the two Macs apart.
   */
  function unameShim(caseDir, sysname, machine, rosetta = false) {
    const binDir = path.join(caseDir, "shim-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, "uname");
    fs.writeFileSync(
      shim,
      `#!/bin/sh\ncase "\${1:-}" in\n  -s) echo '${sysname}' ;;\n  -m) echo '${machine}' ;;\n  *) echo '${sysname}' ;;\nesac\n`,
    );
    fs.chmodSync(shim, 0o755);

    // Absent by default: a real Intel Mac has no such key and the command
    // fails, which is exactly what the unshimmed host does here.
    if (rosetta) {
      const sysctl = path.join(binDir, "sysctl");
      fs.writeFileSync(
        sysctl,
        `#!/bin/sh\ncase "$*" in\n  *sysctl.proc_translated) echo 1 ;;\n  *) exit 1 ;;\nesac\n`,
      );
      fs.chmodSync(sysctl, 0o755);
    }
    return binDir;
  }

  let caseId = 0;

  /**
   * Run a command to completion, collecting its output.
   *
   * Asynchronous on purpose: the fixture server lives in this process, so a
   * synchronous spawn would block the event loop that has to answer the
   * installer's own downloads — the test would deadlock, not fail.
   */
  function runToCompletion(command, argv, env, stdin = "ignore") {
    return new Promise((resolve, reject) => {
      const child = spawn(command, argv, { env, stdio: [stdin, "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  /**
   * Run the installer the way the one-liner does — piped into a shell rather
   * than executed as a file — and return everything a test might assert on.
   *
   * `piped` is the default because that is the shape the product ships; the
   * few tests that run the script as a file say so.
   */
  async function runInstaller({
    args = [],
    uname = ["Linux", "x86_64"],
    /** Pretend the shell is running translated by Rosetta. */
    rosetta = false,
    piped = true,
    /** Content to put on the installer's own stdin, as a pipe would. */
    stdinContent,
    env: extraEnv = {},
  } = {}) {
    const caseDir = path.join(root, `case-${++caseId}`);
    const tmpDir = path.join(caseDir, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const stubLog = path.join(caseDir, "actana-args.log");
    // Outside `tmpDir` on purpose: this is the stand-in for the install layout,
    // and the whole question is whether what the CLI wrote outlives the temp
    // directory the script's EXIT trap removes.
    const placed = path.join(caseDir, "placed", "marker");

    const env = {
      ...process.env,
      PATH: `${unameShim(caseDir, uname[0], uname[1], rosetta)}:${process.env.PATH}`,
      TMPDIR: tmpDir,
      ACTANA_STUB_LOG: stubLog,
      ACTANA_STUB_PLACED: placed,
      ...extraEnv,
    };
    let stdin = "ignore";
    if (stdinContent !== undefined) {
      const stdinPath = path.join(caseDir, "stdin");
      fs.writeFileSync(stdinPath, stdinContent);
      stdin = fs.openSync(stdinPath, "r");
    }

    const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const result = piped
      ? await runToCompletion("/bin/sh", ["-c", `cat "$0" | sh -s -- ${quoted}`, INSTALL_SH], env, stdin)
      : await runToCompletion("/bin/sh", [INSTALL_SH, ...args], env, stdin);

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: `${result.stdout}${result.stderr}`,
      /** The argv `actana` was execed with, or null when it never ran. */
      actanaArgs: fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8").trim() : null,
      tmpDir,
      /** Whether anything survived the script — see `stubActana`. */
      placed: fs.existsSync(placed),
      placedPath: placed,
    };
  }

  /**
   * The fixture paths this test fetched.
   *
   * The cursor is reset per test rather than per call, so "downloaded
   * nothing" is a claim about the test that makes it and not about whatever
   * ran before it.
   */
  let seen = 0;
  beforeEach(() => {
    seen = server.requests.length;
  });
  function traffic() {
    return server.requests.slice(seen);
  }

  const withServer = (args = []) => ["--base-url", server.url, ...args];

  describe("resolving a release", () => {
    it("installs the latest release and places it with `actana place`", async () => {
      const run = await runInstaller({ args: withServer([]) });
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain(`version=${NEW_VERSION}`);
      expect(run.actanaArgs).toBe("place");

      const fetched = traffic();
      expect(fetched).toContain(`/repos/${DEFAULT_REPO}/releases/latest`);
      expect(fetched).toContain(
        `/${DEFAULT_REPO}/releases/download/v${NEW_VERSION}/${tarballName(NEW_VERSION, "linux-x64")}`,
      );
    });

    it("installs the exact release `--version` pins, without asking what is latest", async () => {
      const run = await runInstaller({ args: withServer(["--version", OLD_VERSION]) });
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain(`version=${OLD_VERSION}`);
      // A pinned install that still consults `latest` would drift the day the
      // API answers something unexpected — it has no business asking.
      expect(traffic()).not.toContain(`/repos/${DEFAULT_REPO}/releases/latest`);
    });

    it("accepts a `v`-prefixed version, because that is what the tag looks like", async () => {
      const run = await runInstaller({ args: withServer(["--version", `v${OLD_VERSION}`]) });
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain(`version=${OLD_VERSION}`);
    });

    it("takes the version from the environment too, for cloud-init and friends", async () => {
      const run = await runInstaller({
        args: withServer([]),
        env: { ACTANA_VERSION: OLD_VERSION },
      });
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain(`version=${OLD_VERSION}`);
    });

    it("fails cleanly when the pinned version has no release", async () => {
      const run = await runInstaller({ args: withServer(["--version", "9.9.9"]) });
      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/9\.9\.9/);
      expect(run.output).toMatch(/no release|not found/i);
      expect(run.actanaArgs).toBeNull();
    });

    it("fails cleanly when the release has no build for this platform", async () => {
      const run = await runInstaller({
        args: withServer(["--version", BROKEN_VERSION]),
        uname: ["Linux", "aarch64"],
      });
      expect(run.status).not.toBe(0);
      expect(run.output).toContain("linux-arm64");
      expect(run.actanaArgs).toBeNull();
    });
  });

  describe("detecting the platform", () => {
    const cases = [
      { uname: ["Linux", "x86_64"], target: "linux-x64" },
      { uname: ["Linux", "amd64"], target: "linux-x64" },
      { uname: ["Linux", "aarch64"], target: "linux-arm64" },
      { uname: ["Linux", "arm64"], target: "linux-arm64" },
      { uname: ["Darwin", "arm64"], target: "mac-arm64" },
    ];

    for (const { uname, target } of cases) {
      it(`maps ${uname.join("/")} to ${target}`, async () => {
        const run = await runInstaller({ args: withServer(["--version", OLD_VERSION]), uname });
        expect(run.status, run.output).toBe(0);
        expect(run.stdout).toContain(`target=${target}`);
        expect(traffic()).toContain(
          `/${DEFAULT_REPO}/releases/download/v${OLD_VERSION}/${tarballName(OLD_VERSION, target)}`,
        );
      });
    }

    it("aborts on an unsupported operating system without downloading anything", async () => {
      const run = await runInstaller({ args: withServer([]), uname: ["FreeBSD", "x86_64"] });
      expect(run.status).not.toBe(0);
      expect(run.output).toContain("FreeBSD");
      expect(run.output).toMatch(/Cores run on Linux/i);
      expect(traffic()).toEqual([]);
      expect(run.actanaArgs).toBeNull();
    });

    // An Intel Mac is the one machine this script refuses that has a real
    // answer, so it gets its own message rather than the generic
    // unsupported-OS one: there will never be a `mac-x64` asset, and the Core
    // image is the supported path. Refusing at detection also keeps the
    // operator away from the late, misleading "release v0.1.0 has no build for
    // mac-x64", which describes a broken release rather than the truth.
    // `uname -m` says x86_64 in a shell running under Rosetta, so taking it at
    // face value would refuse a supported machine as an Intel one. Opening a
    // translated terminal is a normal way to get here, and the operator has no
    // reason to connect "Intel Mac" with the shell they happen to be in.
    it("installs the arm64 build on an Apple-silicon Mac under Rosetta", async () => {
      const run = await runInstaller({
        args: withServer(["--version", OLD_VERSION]),
        uname: ["Darwin", "x86_64"],
        rosetta: true,
      });
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain("target=mac-arm64");
    });

    it("sends an Intel Mac to the container path, at detection", async () => {
      const run = await runInstaller({ args: withServer([]), uname: ["Darwin", "x86_64"] });
      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/Intel Mac/i);
      expect(run.output).toMatch(/docker/i);
      // Not the generic refusal, and not the late one.
      expect(run.output).not.toMatch(/unsupported operating system/i);
      expect(run.output).not.toMatch(/no build for/i);
      expect(traffic()).toEqual([]);
      expect(run.actanaArgs).toBeNull();
    });

    it("aborts on an unsupported architecture without downloading anything", async () => {
      const run = await runInstaller({ args: withServer([]), uname: ["Linux", "i686"] });
      expect(run.status).not.toBe(0);
      expect(run.output).toContain("i686");
      expect(traffic()).toEqual([]);
      expect(run.actanaArgs).toBeNull();
    });
  });

  describe("verifying the download", () => {
    it("refuses to extract or run a tarball whose checksum does not match", async () => {
      const run = await runInstaller({ args: withServer(["--version", BROKEN_VERSION]) });
      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/checksum/i);
      expect(run.output).toContain(tarballName(BROKEN_VERSION, "linux-x64"));
      // The whole point of the check: nothing from the tarball ran.
      expect(run.actanaArgs).toBeNull();
      // And the download it refused is not left on disk to be found later.
      expect(fs.readdirSync(run.tmpDir)).toEqual([]);
    });

    it("leaves nothing behind when the release has no build for this platform", async () => {
      const run = await runInstaller({
        args: withServer(["--version", BROKEN_VERSION]),
        uname: ["Linux", "aarch64"],
      });
      expect(run.status).not.toBe(0);
      expect(fs.readdirSync(run.tmpDir)).toEqual([]);
    });

    it("fetches the checksums from the same release as the tarball", async () => {
      await runInstaller({ args: withServer(["--version", OLD_VERSION]) });
      expect(traffic()).toContain(
        `/${DEFAULT_REPO}/releases/download/v${OLD_VERSION}/${SHASUMS_ASSET}`,
      );
    });
  });

  // ─── install is not activation (ADR 0036 C2, #316) ─────────────────────────
  //
  // This block replaces the `handing off to \`actana setup\`` one it is the same
  // size as. The old contract was "the flags reach setup, the exit code comes
  // back, and stdin is not eaten"; the new one is "the bundle is placed, setup
  // is not run, setup's flags are refused, the failure still comes back, and
  // stdin is still not eaten". Deleting the old cases without replacing them
  // would have left the negative space around the tail thinner than the tail
  // it removed.
  describe("placing the bundle, and stopping there", () => {
    it.each([[[]], [["--version", OLD_VERSION]]])(
      "runs `actana place`, and never `actana setup`, with %j",
      async (args) => {
        const run = await runInstaller({ args: withServer(args) });
        expect(run.status, run.output).toBe(0);
        expect(run.actanaArgs).toBe("place");
        expect(run.actanaArgs).not.toMatch(/setup/);
      },
    );

    it("runs `actana place` with no terminal, the same as when piped", async () => {
      // The one shape that used to take the other branch: run as a file, so
      // the old tail's `[ -t 0 ]` test would have handed stdin straight
      // through. There is no branch left — nothing the script runs prompts.
      const run = await runInstaller({ args: withServer([]), piped: false });
      expect(run.status, run.output).toBe(0);
      expect(run.actanaArgs).toBe("place");
      expect(run.stdout).toContain("tty=no");
    });

    // The property the whole ticket turns on. Before #316 the extracted tree
    // survived only because `actana setup` copied it out of the temp
    // directory, so a script that stopped calling setup and placed nothing
    // would install nothing and still exit 0 — the most expensive way to pass
    // a test suite.
    it("leaves something behind: the placement outlives the temp dir", async () => {
      const run = await runInstaller({ args: withServer([]) });
      expect(run.status, run.output).toBe(0);
      expect(run.placed, `nothing was placed at ${run.placedPath}`).toBe(true);
      expect(fs.readFileSync(run.placedPath, "utf8")).toContain("place");
      // And the download itself did not survive with it.
      expect(fs.readdirSync(run.tmpDir)).toEqual([]);
    });

    it("prints the next command once — the CLI's copy, not a second one", async () => {
      const run = await runInstaller({ args: withServer([]) });
      expect(run.status, run.output).toBe(0);
      // The stub stands in for the CLI, which is the half that knows the
      // layout and therefore the half that prints the runnable command. A
      // script that printed its own `actana setup` line would be a second
      // copy free to disagree with it — about the launcher's path, most of
      // all, which is exactly what an operator whose bin dir is not on PATH
      // needs to be right.
      expect(run.stdout).toMatch(/^NEXT \S+\/bin\/actana setup$/m);
      expect(run.stdout.match(/\bsetup\b/g)).toHaveLength(1);
    });

    it("hands the CLI an empty stdin, so a piped install is not eaten by its child", async () => {
      // The installer is run as a file with real data waiting on its stdin —
      // the shape a `curl | bash` run has, where that data is the rest of the
      // script. If it passed stdin through, the stub would read LEFTOVER and
      // the one-liner could be eaten by its own child.
      const run = await runInstaller({
        args: withServer([]),
        piped: false,
        stdinContent: "LEFTOVER\n",
      });
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain("stdin=");
      expect(run.stdout).not.toContain("LEFTOVER");
    });

    // Every flag `usage()` used to advertise as passthrough, one case each: an
    // operator pasting last month's command line has to be told where their
    // flag went, and a loop inside one `it` would stop at the first one that
    // regressed.
    const SETUP_FLAGS = [
      ["--yes"],
      ["--public-host", "10.0.0.7"],
      ["--public-host=10.0.0.7"],
      ["--label", "build-box"],
      ["--port", "9443"],
      ["--host", "0.0.0.0"],
      ["--no-harnesses"],
      ["--with-codex"],
    ];

    it.each(SETUP_FLAGS)("refuses %s, and says it belongs to `actana setup`", async (...flag) => {
      const run = await runInstaller({ args: withServer(flag) });
      expect(run.status, `${flag.join(" ")}: ${run.output}`).not.toBe(0);
      expect(run.output).toContain(flag[0].split("=")[0]);
      expect(run.output).toMatch(/actana setup/);
      // Refused while parsing, so nothing was fetched and nothing was run.
      expect(run.actanaArgs).toBeNull();
      expect(run.placed).toBe(false);
      expect(traffic()).toEqual([]);
    });

    it("refuses a flag nobody owns rather than passing it on", async () => {
      // The old script swallowed every unrecognised token and handed it to
      // setup, so `--pubic-host 10.0.0.7` reached the CLI and was rejected
      // there. There is nothing downstream to reject it now, and silently
      // dropping the one flag that decides whether a Panel can reach this
      // machine is the failure this refusal exists for.
      const run = await runInstaller({ args: withServer(["--pubic-host", "10.0.0.7"]) });
      expect(run.status).not.toBe(0);
      expect(run.output).toContain("--pubic-host");
      expect(run.actanaArgs).toBeNull();
      expect(traffic()).toEqual([]);
    });

    it("comes back with the placement's own failure status", async () => {
      // There is no `setup` exit code to propagate any more, and `set -e` is
      // what carries this one out. A placement that failed and an install that
      // reported success would be the worst of the two.
      const run = await runInstaller({ args: withServer([]), env: { ACTANA_STUB_EXIT: "7" } });
      expect(run.status).toBe(7);
      expect(run.placed).toBe(false);
    });

    it("leaves no temporary files behind", async () => {
      const run = await runInstaller({ args: withServer([]) });
      expect(run.status, run.output).toBe(0);
      expect(fs.readdirSync(run.tmpDir)).toEqual([]);
    });

    it("leaves no temporary files behind when the placement fails either", async () => {
      const run = await runInstaller({ args: withServer([]), env: { ACTANA_STUB_EXIT: "7" } });
      expect(run.status).toBe(7);
      expect(fs.readdirSync(run.tmpDir)).toEqual([]);
    });
  });

  describe("its own interface", () => {
    it("prints usage for --help and touches nothing", async () => {
      const run = await runInstaller({ args: ["--help"] });
      expect(run.status).toBe(0);
      expect(run.stdout).toMatch(/--version/);
      expect(traffic()).toEqual([]);
    });

    it("describes what it does now: two commands, and no passthrough", async () => {
      const run = await runInstaller({ args: ["--help"] });
      const text = run.stdout;
      // The help is the only place an operator learns there is a second
      // command, so it has to name it and it has to stop advertising the
      // flags the script no longer carries.
      expect(text).toMatch(/actana setup/);
      expect(text).toMatch(/Installing is not activating/i);
      expect(text).not.toMatch(/passed through|passthrough/i);
      for (const gone of ["--with-", "--no-harnesses"]) {
        // Named only as somebody else's, never as this script's own option.
        const owned = new RegExp(`^\\s{2}${gone.replace("-", "\\-")}\\S*\\s{2,}\\S`, "m");
        expect(text, `${gone} is still documented as an installer option`).not.toMatch(owned);
      }
    });

    it("does not claim to hand over to `actana setup` in its own header", () => {
      // The header is the first thing anyone reading the script sees, and it
      // said the job was "fetch, verify, exec" for as long as that was true.
      const source = fs.readFileSync(INSTALL_SH, "utf8");
      const header = source.slice(0, source.indexOf("set -eu"));
      expect(header).not.toMatch(/hand over to/i);
      expect(header).not.toMatch(/fetch, verify, exec/);
      expect(header).toMatch(/fetch, verify, place/);
    });

    it("rejects a flag of its own that was given no value", async () => {
      const run = await runInstaller({ args: withServer(["--version"]) });
      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/--version/);
      expect(traffic()).toEqual([]);
    });

    it("rejects a flag whose value is the next flag, rather than eating it", async () => {
      // `--version --repo` pinning a release called "--repo" and swallowing
      // the flag behind it is the quiet kind of wrong.
      for (const args of [["--version", "--repo"], ["--repo", "--base-url"], ["--version="]]) {
        const run = await runInstaller({ args: withServer(args) });
        expect(run.status, `${args.join(" ")}: ${run.output}`).not.toBe(0);
        expect(run.output).toMatch(/needs a value/);
      }
      expect(traffic()).toEqual([]);
    });

    it("installs from another repository when told to", async () => {
      const run = await runInstaller({ args: withServer(["--repo", "someone/fork"]) });
      // The fixture only answers for its own repo, so the paths asked for are
      // the observable behaviour — a fork install must not silently fall back
      // to the default repository.
      expect(run.status).not.toBe(0);
      expect(traffic().some((p) => p.includes("someone/fork"))).toBe(true);
      expect(traffic().some((p) => p.includes(DEFAULT_REPO))).toBe(false);
    });

    it("is servable and runnable straight off the release server", async () => {
      // The literal one-liner: fetch the script over HTTP, pipe it to a shell.
      const caseDir = path.join(root, "one-liner");
      fs.mkdirSync(caseDir, { recursive: true });
      const stubLog = path.join(caseDir, "actana-args.log");
      const result = await runToCompletion(
        "/bin/sh",
        ["-c", `curl -fsSL "$0/install.sh" | sh -s -- --base-url "$0"`, server.url],
        { ...process.env, TMPDIR: caseDir, ACTANA_STUB_LOG: stubLog },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(stubLog, "utf8").trim()).toBe("place");
    });
  });
});
