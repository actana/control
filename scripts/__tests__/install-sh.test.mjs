// `install.sh` is the product's front door, and it runs on machines nobody
// tests on — so it is exercised here as the operator runs it: the real script,
// piped to a real shell, against a server that answers exactly like GitHub
// Releases, with a stub `bin/actana` in the tarball that records what the
// bootstrapper handed it.
//
// What is deliberately NOT here: systemd, a real Core, a real network. The
// container e2e (`scripts/e2e-install-sh-linux.mjs`) runs the same script
// against a real tarball on a real init system; this file covers the decisions
// the bootstrapper itself makes — platform mapping, version resolution,
// checksum verification, flag passthrough, exit codes — in under a second, on
// every platform CI runs.
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

/** The two releases the fixture serves. `--version` pins the older one. */
const OLD_VERSION = "0.1.0";
const NEW_VERSION = "0.2.0";

/**
 * Stands in for the tarball's `bin/actana`: prints what it was called with and
 * whether it got a terminal, so the tests can assert both the flags that
 * reached `actana setup` and that a piped run has no TTY to prompt on.
 */
const stubActana = (version, target) => `#!/bin/sh
printf 'stub-actana version=%s target=%s\\n' '${version}' '${target}'
printf 'args=%s\\n' "$*"
if [ -t 0 ]; then printf 'tty=yes\\n'; else printf 'tty=no\\n'; fi
# Whatever the bootstrapper left on stdin. Empty means it handed over
# /dev/null, which is what stops a piped install being eaten by its own child.
printf 'stdin=%s\\n' "$(cat)"
if [ -n "\${ACTANA_STUB_LOG:-}" ]; then printf '%s\\n' "$*" >> "\${ACTANA_STUB_LOG}"; fi
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

    // Every target, both versions: the mapping tests need a real asset to
    // download for each, and the pinning test needs two releases to choose
    // between.
    for (const version of [OLD_VERSION, NEW_VERSION]) {
      for (const target of ["linux-x64", "linux-arm64", "mac-arm64"]) {
        writeStubRelease({ dir: releaseDir, version, target, script: stubActana(version, target) });
      }
    }
    // mac-x64 exists in the older release only — that gap is what the
    // "release has no build for this platform" case is about.
    writeStubRelease({
      dir: releaseDir,
      version: OLD_VERSION,
      target: "mac-x64",
      script: stubActana(OLD_VERSION, "mac-x64"),
    });

    server = await startFixtureReleaseServer({
      dir: releaseDir,
      scriptPath: INSTALL_SH,
      corruptAssets: [tarballName(OLD_VERSION, "mac-arm64")],
    });
  });

  afterAll(async () => {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A `uname` that reports the machine the test is pretending to run on. */
  function unameShim(caseDir, sysname, machine) {
    const binDir = path.join(caseDir, "shim-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, "uname");
    fs.writeFileSync(
      shim,
      `#!/bin/sh\ncase "\${1:-}" in\n  -s) echo '${sysname}' ;;\n  -m) echo '${machine}' ;;\n  *) echo '${sysname}' ;;\nesac\n`,
    );
    fs.chmodSync(shim, 0o755);
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
    piped = true,
    /** Content to put on the installer's own stdin, as a pipe would. */
    stdinContent,
    env: extraEnv = {},
  } = {}) {
    const caseDir = path.join(root, `case-${++caseId}`);
    const tmpDir = path.join(caseDir, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const stubLog = path.join(caseDir, "actana-args.log");

    const env = {
      ...process.env,
      PATH: `${unameShim(caseDir, uname[0], uname[1])}:${process.env.PATH}`,
      TMPDIR: tmpDir,
      ACTANA_STUB_LOG: stubLog,
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
    it("installs the latest release and hands off to `actana setup`", async () => {
      const run = await runInstaller({ args: withServer(["--yes"]) });
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain(`version=${NEW_VERSION}`);
      expect(run.actanaArgs).toBe("setup --yes");

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
      const run = await runInstaller({ args: withServer([]), uname: ["Darwin", "x86_64"] });
      expect(run.status).not.toBe(0);
      expect(run.output).toContain("mac-x64");
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
        // mac-arm64 is the corrupted asset; every other target installs. Both
        // outcomes prove the mapping, since the request names the target.
        expect(traffic()).toContain(
          `/${DEFAULT_REPO}/releases/download/v${OLD_VERSION}/${tarballName(OLD_VERSION, target)}`,
        );
        if (target !== "mac-arm64") {
          expect(run.status, run.output).toBe(0);
          expect(run.stdout).toContain(`target=${target}`);
        }
      });
    }

    it("aborts on an unsupported operating system without downloading anything", async () => {
      const run = await runInstaller({ args: withServer([]), uname: ["FreeBSD", "x86_64"] });
      expect(run.status).not.toBe(0);
      expect(run.output).toContain("FreeBSD");
      expect(run.output).toMatch(/macOS and Linux/i);
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
      const run = await runInstaller({
        args: withServer(["--version", OLD_VERSION]),
        uname: ["Darwin", "arm64"],
      });
      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/checksum/i);
      expect(run.output).toContain(tarballName(OLD_VERSION, "mac-arm64"));
      // The whole point of the check: nothing from the tarball ran.
      expect(run.actanaArgs).toBeNull();
      // And the download it refused is not left on disk to be found later.
      expect(fs.readdirSync(run.tmpDir)).toEqual([]);
    });

    it("leaves nothing behind when the release has no build for this platform", async () => {
      const run = await runInstaller({ args: withServer([]), uname: ["Darwin", "x86_64"] });
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

  describe("handing off to `actana setup`", () => {
    it("forwards every flag it does not own, in order", async () => {
      const run = await runInstaller({
        args: withServer(["--yes", "--public-host", "10.0.0.7", "--label", "build-box", "--no-harnesses"]),
      });
      expect(run.status, run.output).toBe(0);
      expect(run.actanaArgs).toBe("setup --yes --public-host 10.0.0.7 --label build-box --no-harnesses");
    });

    it("hands setup an empty stdin when there is no terminal", async () => {
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

    it("gives setup no terminal to prompt on when piped", async () => {
      const run = await runInstaller({ args: withServer([]), piped: true });
      expect(run.stdout).toContain("tty=no");
    });

    it("propagates setup's exit code", async () => {
      const run = await runInstaller({ args: withServer([]), env: { ACTANA_STUB_EXIT: "7" } });
      expect(run.status).toBe(7);
    });

    it("leaves no temporary files behind", async () => {
      const run = await runInstaller({ args: withServer([]) });
      expect(run.status, run.output).toBe(0);
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

    it("rejects a flag of its own that was given no value", async () => {
      const run = await runInstaller({ args: withServer(["--version"]) });
      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/--version/);
      expect(traffic()).toEqual([]);
    });

    it("rejects a flag whose value is the next flag, rather than eating it", async () => {
      // `--version --yes` pinning a release called "--yes" and swallowing the
      // flag that was meant for setup is the quiet kind of wrong.
      for (const args of [["--version", "--yes"], ["--repo", "--yes"], ["--version="]]) {
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
        ["-c", `curl -fsSL "$0/install.sh" | sh -s -- --base-url "$0" --yes`, server.url],
        { ...process.env, TMPDIR: caseDir, ACTANA_STUB_LOG: stubLog },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(stubLog, "utf8").trim()).toBe("setup --yes");
    });
  });
});
