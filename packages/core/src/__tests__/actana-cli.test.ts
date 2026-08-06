import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeRegistrationBlob } from "@actana/shared/registration-blob";
import { runActanaCli, EXIT_USAGE, type ActanaCliDeps } from "../actana-cli";
import { installDirFor, resolveActanaLayout } from "../actana-layout";
import { releaseAssetName, releaseChannel } from "../actana-release";
import type { ActanaSystem, CommandResult } from "../actana-system";
import { materialFilePath } from "../core-material-store";
import { fixtureFetcher, writeRelease } from "./release-fixture";

const MANIFEST = {
  version: "0.1.0",
  protocolVersion: "3",
  target: "linux-x64",
  platform: "linux",
  arch: "x64",
  nodeVersion: "24.15.0",
};

const RUNNING_UNIT = [
  "LoadState=loaded",
  "ActiveState=active",
  "SubState=running",
  "MainPID=4211",
].join("\n");

function fakeSystem(overrides: Record<string, CommandResult> = {}) {
  const calls: string[][] = [];
  const signals: Array<[number, string]> = [];
  const system: ActanaSystem & {
    calls: string[][];
    signals: Array<[number, string]>;
    /** Answers `confirm` in order; the last answer repeats. */
    answers: boolean[];
    /** Exit code for `passthrough` when the command line contains the key. */
    passthroughFailures: Record<string, number>;
  } = {
    calls,
    signals,
    answers: [],
    passthroughFailures: {},
    run(command, args) {
      calls.push([command, ...args]);
      const key = [command, ...args].join(" ");
      for (const [prefix, result] of Object.entries(overrides)) {
        if (key.startsWith(prefix)) return result;
      }
      // `tar` is faked by nobody: `actana update` unpacks a real tarball built
      // moments ago, so the archive handling under test is the real one.
      if (command === "tar") {
        const result = spawnSync(command, args, { encoding: "utf8" });
        return {
          status: result.status ?? 127,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    async passthrough(command, args) {
      calls.push([command, ...args]);
      const line = args.join(" ");
      for (const [needle, code] of Object.entries(system.passthroughFailures)) {
        if (line.includes(needle)) return code;
      }
      return 0;
    },
    async waitForPort() {
      return true;
    },
    async confirm() {
      return system.answers.length > 1 ? (system.answers.shift() ?? true) : (system.answers[0] ?? true);
    },
    signal(pid, sig) {
      signals.push([pid, sig]);
      return true;
    },
  };
  return system;
}

/** The stand-in release channel `actana update` is pointed at with --base-url. */
const RELEASE_BASE_URL = "http://releases.test";
const CHANNEL = releaseChannel({ baseUrl: RELEASE_BASE_URL });

let tmp: string;
let home: string;
let installRoot: string;
let releaseDir: string;
let out: string[];
let err: string[];
let daemonRuns: number;

function makeTarballTree(root: string, manifest = MANIFEST): void {
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "node", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "actana"), "#!/bin/sh\n");
  fs.chmodSync(path.join(root, "bin", "actana"), 0o755);
  fs.writeFileSync(path.join(root, "app", "core-entry.cjs"), "// daemon\n");
  fs.writeFileSync(path.join(root, "node", "bin", "node"), "#!/bin/sh\n");
  fs.writeFileSync(
    path.join(root, "core-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

function deps(argv: string[], system: ActanaSystem, over: Partial<ActanaCliDeps> = {}): ActanaCliDeps {
  return {
    argv,
    env: { HOME: home, PATH: path.join(home, ".local", "bin") },
    home,
    hostname: "vm-1",
    networkInterfaces: { eth0: [{ address: "10.0.0.5", family: "IPv4", internal: false }] },
    platform: "linux",
    arch: "x64",
    user: "op",
    uid: 501,
    installRoot,
    interactive: false,
    system,
    fetcher: fixtureFetcher(releaseDir, CHANNEL),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    probeHarnesses: () => ({ claude: { status: "available", version: "2.1.0" } }),
    runDaemon: async () => {
      daemonRuns += 1;
    },
    ...over,
  };
}

/** The layout the CLI resolves for the scratch home under test. */
function layoutForHome(platform: NodeJS.Platform = "linux") {
  return resolveActanaLayout({ HOME: home }, home, platform);
}

/** Run `actana setup` with defaults, the precondition for the other verbs. */
async function setup(system: ActanaSystem, extra: string[] = []): Promise<number> {
  return runActanaCli(deps(["setup", ...extra], system));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actana-cli-"));
  home = path.join(tmp, "home");
  installRoot = path.join(tmp, "extract", "actana-core-0.1.0-linux-x64");
  releaseDir = path.join(tmp, "releases");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  makeTarballTree(installRoot);
  out = [];
  err = [];
  daemonRuns = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("usage", () => {
  it("prints help and succeeds with no arguments", async () => {
    expect(await runActanaCli(deps([], fakeSystem()))).toBe(0);
    expect(out.join("\n")).toMatch(/actana <command>/);
  });

  it("lists every lifecycle verb", async () => {
    await runActanaCli(deps(["--help"], fakeSystem()));
    const text = out.join("\n");
    const verbs = ["setup", "status", "token", "update", "start", "stop", "restart", "logs", "uninstall"];
    for (const verb of verbs) {
      expect(text).toMatch(new RegExp(`^\\s+${verb}\\b`, "m"));
    }
  });

  it("says `pairing token`, never `registration blob`", async () => {
    await runActanaCli(deps(["--help"], fakeSystem()));
    expect(out.join("\n").toLowerCase()).toContain("pairing token");
    expect(out.join("\n").toLowerCase()).not.toContain("registration blob");
  });

  it("reports the bundled version", async () => {
    expect(await runActanaCli(deps(["--version"], fakeSystem()))).toBe(0);
    expect(out.join("\n")).toContain("0.1.0");
  });

  it("rejects an unknown verb on stderr with a non-zero exit", async () => {
    expect(await runActanaCli(deps(["frobnicate"], fakeSystem()))).toBe(2);
    expect(err.join("\n")).toMatch(/frobnicate/);
    expect(out).toEqual([]);
  });

  it("rejects an unknown flag rather than silently ignoring it", async () => {
    expect(await runActanaCli(deps(["setup", "--porto", "9000"], fakeSystem()))).toBe(2);
    expect(err.join("\n")).toMatch(/--porto/);
  });
});

// ─── help ↔ dispatch drift guard (issue 92) ─────────────────────────────────
//
// `--help` once advertised an `agents` verb the dispatch had never had, so
// every operator who read the help and typed what it said got "unknown
// command". Nothing failed but the operator. These two tests close both
// directions of that gap.

/** The verbs the `Commands:` block of what `--help` actually prints advertises. */
async function documentedVerbs(): Promise<string[]> {
  out = [];
  await runActanaCli(deps(["--help"], fakeSystem()));
  // The block runs from `Commands:` to the blank line before `Setup options:`.
  const block = out.join("\n").split(/^Commands:$/m)[1]?.split(/\n\s*\n/)[0] ?? "";
  const verbs = new Set<string>();
  for (const line of block.split("\n")) {
    // Two-space indent, then the verb — the continuation row that spells out
    // `token regenerate` re-names `token`, which the set folds away.
    const match = /^ {2}(\w+)/.exec(line);
    if (match) verbs.add(match[1]);
  }
  return [...verbs];
}

/**
 * The verbs the dispatch `switch` has a case for.
 *
 * Read off the source because the switch is the only place that knows: a list
 * exported for the test to compare against would be a third thing to keep in
 * sync, which is the bug this guards. A refactor that replaces the switch
 * breaks this loudly rather than quietly passing — a parse that finds nothing
 * asserts that, rather than sliding through on an empty list.
 */
function dispatchedVerbs(): string[] {
  const source = fs.readFileSync(path.resolve(__dirname, "../actana-cli.ts"), "utf8");
  const start = source.indexOf("switch (verb) {");
  expect(start, "the dispatch switch moved — this guard parses `switch (verb) {`").toBeGreaterThan(
    -1,
  );
  const body = source.slice(start, source.indexOf("default:", start));
  const verbs = [...body.matchAll(/case "(\w+)":/g)].map((match) => match[1]);
  expect(verbs).toContain("setup");
  return verbs;
}

describe("help and dispatch stay in sync", () => {
  it("dispatches every verb the help advertises", async () => {
    const verbs = await documentedVerbs();
    expect(verbs).toContain("setup");

    for (const verb of verbs) {
      err = [];
      // A flag no verb owns: each one rejects it while parsing, so the verb is
      // proven to be dispatched without any of them being run for real.
      await runActanaCli(deps([verb, "--not-a-real-flag"], fakeSystem()));
      expect(err.join("\n")).not.toContain(`unknown command: ${verb}`);
    }
  });

  it("advertises every verb it dispatches, `daemon` excepted", async () => {
    const documented = new Set(await documentedVerbs());
    // `daemon` is what the unit / LaunchAgent execs, not something an operator
    // types, so it is the one verb deliberately left out of the help.
    expect(dispatchedVerbs().filter((verb) => !documented.has(verb))).toEqual(["daemon"]);
  });
});

describe("setup", () => {
  it("installs, starts, and prints a pairing token with a paste instruction", async () => {
    expect(await setup(fakeSystem())).toBe(0);

    const text = out.join("\n");
    expect(text).toMatch(/pairing token/i);
    expect(text).toMatch(/paste .*panel/i);

    const token = out.find((line) => decodeRegistrationBlob(line) !== null);
    expect(token).toBeDefined();
    expect(decodeRegistrationBlob(token!)?.endpoint).toBe("wss://10.0.0.5:8443");
  });

  it("tells a re-running operator their existing pairing survives", async () => {
    await setup(fakeSystem());
    out.length = 0;
    await setup(fakeSystem());

    expect(out.join("\n")).toMatch(/unchanged/i);
    expect(out.join("\n")).toMatch(/stays paired/i);
  });

  it("tells an operator who moved the Core to re-address their Panel, not re-pair blind", async () => {
    await setup(fakeSystem());
    out.length = 0;

    await setup(fakeSystem(), ["--public-host", "core.example"]);

    const text = out.join("\n");
    // The credentials survived the move (ADR 0016 D18) — the address did not,
    // and that is the half the Panel holds.
    expect(text).toMatch(/unchanged/i);
    expect(text).toContain("core.example");
    expect(text).not.toMatch(/stays paired/i);
    expect(decodeRegistrationBlob(out.find((l) => decodeRegistrationBlob(l) !== null)!)?.endpoint)
      .toBe("wss://core.example:8443");
  });

  it("defaults the public host to the machine's routable address", async () => {
    await setup(fakeSystem());
    expect(out.join("\n")).toContain("wss://10.0.0.5:8443");
  });

  it("honours --public-host, --port and --label", async () => {
    await setup(fakeSystem(), ["--public-host", "core.example", "--port", "9443", "--label", "eu-1"]);

    const token = out.find((line) => decodeRegistrationBlob(line) !== null)!;
    const blob = decodeRegistrationBlob(token)!;
    expect(blob.endpoint).toBe("wss://core.example:9443");
    expect(blob.label).toBe("eu-1");
  });

  it("rejects a port that is not a port", async () => {
    expect(await setup(fakeSystem(), ["--port", "not-a-port"])).toBe(2);
    expect(err.join("\n")).toMatch(/port/i);
  });

  it("warns when the launcher's directory is not on PATH", async () => {
    const system = fakeSystem();
    await runActanaCli(deps(["setup"], system, { env: { HOME: home, PATH: "/usr/bin" } }));
    expect(out.join("\n")).toMatch(/\.local\/bin/);
    expect(out.join("\n")).toMatch(/PATH/);
  });

  it("says so when the daemon did not come up, and exits non-zero", async () => {
    const system = fakeSystem();
    system.waitForPort = async () => false;
    expect(await setup(system)).toBe(1);
    expect(err.join("\n")).toMatch(/did not start|not listening/i);
  });

  it("reports a systemd failure as an error rather than a stack trace", async () => {
    const system = fakeSystem({
      "systemctl --user enable": { status: 1, stdout: "", stderr: "Failed to enable unit" },
    });
    expect(await setup(system)).toBe(1);
    expect(err.join("\n")).toContain("Failed to enable unit");
    expect(err.join("\n")).not.toMatch(/at Object\.|node:internal/);
  });
});

describe("status", () => {
  it("reports healthy and exits 0 once setup has run", async () => {
    await setup(fakeSystem());
    out.length = 0;

    const system = fakeSystem({
      "systemctl --user show": { status: 0, stdout: RUNNING_UNIT, stderr: "" },
      "loginctl show-user": { status: 0, stdout: "Linger=yes", stderr: "" },
    });
    expect(await runActanaCli(deps(["status"], system))).toBe(0);

    const text = out.join("\n");
    expect(text).toMatch(/healthy/i);
    expect(text).toContain("0.1.0");
    expect(text).toContain("wss://10.0.0.5:8443");
    expect(text).toMatch(/protocol.*3/i);
    expect(text).toMatch(/claude\s+available/);
  });

  it("exits non-zero when the daemon is not running", async () => {
    await setup(fakeSystem());
    out.length = 0;

    const system = fakeSystem({
      "systemctl --user show": {
        status: 0,
        stdout: "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0",
        stderr: "",
      },
    });
    expect(await runActanaCli(deps(["status"], system))).toBe(1);
    expect(out.join("\n")).toMatch(/stopped/i);
  });

  it("says not-installed on a fresh machine instead of erroring", async () => {
    expect(await runActanaCli(deps(["status"], fakeSystem()))).toBe(1);
    expect(out.join("\n")).toMatch(/not installed/i);
    expect(out.join("\n")).toContain("actana setup");
  });

  it("treats a missing unit file as no service rather than an unknown state", async () => {
    await setup(fakeSystem());
    out.length = 0;

    const system = fakeSystem({
      "systemctl --user show": {
        status: 0,
        stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0",
        stderr: "",
      },
    });
    await runActanaCli(deps(["status"], system));
    expect(out.join("\n")).toMatch(/State\s+not installed/);
  });
});

describe("token", () => {
  it("reprints the same pairing token setup printed", async () => {
    await setup(fakeSystem());
    const printed = out.find((line) => decodeRegistrationBlob(line) !== null)!;
    out.length = 0;

    expect(await runActanaCli(deps(["token"], fakeSystem()))).toBe(0);
    const reprinted = decodeRegistrationBlob(out.join("\n").trim())!;
    expect(reprinted.caCert).toBe(decodeRegistrationBlob(printed)!.caCert);
    expect(reprinted.endpoint).toBe("wss://10.0.0.5:8443");
  });

  it("puts only the token on stdout so it can be piped", async () => {
    await setup(fakeSystem());
    out.length = 0;
    err.length = 0;

    await runActanaCli(deps(["token"], fakeSystem()));
    expect(out).toHaveLength(1);
    expect(decodeRegistrationBlob(out[0])).not.toBeNull();
    expect(err.join("\n").toLowerCase()).toContain("pairing token");
  });

  it("fails clearly when nothing is installed", async () => {
    expect(await runActanaCli(deps(["token"], fakeSystem()))).toBe(1);
    expect(err.join("\n")).toContain("actana setup");
  });
});

describe("token regenerate", () => {
  it("issues credentials the old pairing token's no longer match", async () => {
    await setup(fakeSystem());
    const old = decodeRegistrationBlob(out.find((l) => decodeRegistrationBlob(l) !== null)!)!;
    out.length = 0;
    err.length = 0;

    expect(await runActanaCli(deps(["token", "regenerate"], fakeSystem()))).toBe(0);

    const fresh = decodeRegistrationBlob(out.join("\n").trim())!;
    // Every credential a Panel pinned is replaced: a client cert signed by the
    // old CA is not signed by this one, so the old blob cannot complete the
    // mTLS handshake against the daemon that now serves these.
    expect(fresh.caCert).not.toBe(old.caCert);
    expect(fresh.clientCert).not.toBe(old.clientCert);
    expect(fresh.clientKey).not.toBe(old.clientKey);
    expect(fresh.bearer).not.toBe(old.bearer);
    // The Core is the same Core, at the same address.
    expect(fresh.endpoint).toBe(old.endpoint);
    expect(fresh.label).toBe(old.label);
  });

  it("keeps stdout a single pipeable token and warns on stderr", async () => {
    await setup(fakeSystem());
    out.length = 0;
    err.length = 0;

    await runActanaCli(deps(["token", "regenerate"], fakeSystem()));
    expect(out).toHaveLength(1);
    expect(decodeRegistrationBlob(out[0])).not.toBeNull();
    expect(err.join("\n")).toMatch(/no longer work/i);
    expect(err.join("\n")).toMatch(/re-pair/i);
  });

  it("restarts the daemon — until it reloads, the old credentials still work", async () => {
    await setup(fakeSystem());
    const system = fakeSystem();

    await runActanaCli(deps(["token", "regenerate"], system));
    expect(system.calls.map((c) => c.join(" "))).toContain(
      "systemctl --user restart actana-core.service",
    );
  });

  it("says the daemon is still serving the old credentials when the restart fails", async () => {
    await setup(fakeSystem());
    err.length = 0;
    const system = fakeSystem({
      "systemctl --user restart": { status: 1, stdout: "", stderr: "Job failed" },
    });

    expect(await runActanaCli(deps(["token", "regenerate"], system))).not.toBe(0);
    expect(err.join("\n")).toContain("Job failed");
    expect(err.join("\n")).toMatch(/old credentials/i);
  });

  it("asks before locking every paired Panel out, and stops at no", async () => {
    await setup(fakeSystem());
    const before = fs.readFileSync(materialFilePath(layoutForHome().configDir), "utf8");
    const system = fakeSystem();
    system.confirm = async () => false;

    expect(await runActanaCli(deps(["token", "regenerate"], system, { interactive: true }))).toBe(1);
    expect(fs.readFileSync(materialFilePath(layoutForHome().configDir), "utf8")).toBe(before);
  });

  it("does not prompt with --yes", async () => {
    await setup(fakeSystem());
    const system = fakeSystem();
    system.confirm = async () => {
      throw new Error("should not have prompted");
    };

    expect(
      await runActanaCli(deps(["token", "regenerate", "--yes"], system, { interactive: true })),
    ).toBe(0);
  });

  it("refuses before setup has run", async () => {
    expect(await runActanaCli(deps(["token", "regenerate"], fakeSystem()))).toBe(1);
    expect(err.join("\n")).toContain("actana setup");
  });
});

describe("update", () => {
  /** `actana update`, pointed at the fixture release channel. */
  const update = (system: ActanaSystem, extra: string[] = []) =>
    runActanaCli(deps(["update", "--base-url", RELEASE_BASE_URL, ...extra], system));

  it("lands a newer release, restarts, and reports the versions", async () => {
    await setup(fakeSystem());
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "linux-x64" });
    out.length = 0;
    const system = fakeSystem();

    expect(await update(system)).toBe(0);
    expect(out.join("\n")).toContain("0.1.0 → 0.2.0");
    expect(system.calls.map((c) => c.join(" "))).toContain(
      "systemctl --user restart actana-core.service",
    );
  });

  it("leaves `status` reporting the new version", async () => {
    await setup(fakeSystem());
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "linux-x64" });
    await update(fakeSystem());
    out.length = 0;

    await runActanaCli(
      deps(["status"], fakeSystem({ "systemctl --user show": { status: 0, stdout: RUNNING_UNIT, stderr: "" } })),
    );
    expect(out.join("\n")).toContain("0.2.0");
  });

  it("says the pairing credentials survived — a paired Panel stays paired", async () => {
    await setup(fakeSystem());
    const before = decodeRegistrationBlob(out.find((l) => decodeRegistrationBlob(l) !== null)!)!;
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "linux-x64" });
    out.length = 0;
    await update(fakeSystem());
    expect(out.join("\n")).toMatch(/unchanged|stay paired/i);

    out.length = 0;
    await runActanaCli(deps(["token"], fakeSystem()));
    expect(decodeRegistrationBlob(out.join("\n").trim())!.caCert).toBe(before.caCert);
  });

  it("aborts on a bad checksum, leaving the old install running", async () => {
    await setup(fakeSystem());
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "linux-x64" });
    out.length = 0;
    err.length = 0;

    const system = fakeSystem();
    const code = await runActanaCli(
      deps(["update", "--base-url", RELEASE_BASE_URL], system, {
        fetcher: fixtureFetcher(releaseDir, CHANNEL, {
          corrupt: [releaseAssetName("0.2.0", "linux-x64")],
        }),
      }),
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/checksum/i);
    expect(err.join("\n")).not.toMatch(/at Object\.|node:internal/);
    expect(fs.existsSync(installDirFor(layoutForHome(), "0.2.0"))).toBe(false);
    expect(system.calls.some((c) => c.join(" ").includes("restart"))).toBe(false);
  });

  it("installs the exact version --version names, for a Panel version lock", async () => {
    await setup(fakeSystem());
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "linux-x64" });
    writeRelease({ dir: releaseDir, version: "0.3.0", target: "linux-x64" });
    out.length = 0;

    expect(await update(fakeSystem(), ["--version", "0.2.0"])).toBe(0);
    expect(out.join("\n")).toContain("0.1.0 → 0.2.0");
    expect(out.join("\n")).not.toContain("0.3.0");
  });

  it("says so and does nothing when already on the newest release", async () => {
    await setup(fakeSystem());
    out.length = 0;
    const system = fakeSystem();

    // The fixture serves only 0.1.0 — the version setup installed.
    writeRelease({ dir: releaseDir, version: "0.1.0", target: "linux-x64" });
    expect(await update(system)).toBe(0);
    expect(out.join("\n")).toMatch(/already/i);
    expect(system.calls.some((c) => c.join(" ").includes("restart"))).toBe(false);
  });

  it("explains an unreachable release channel rather than throwing", async () => {
    await setup(fakeSystem());
    err.length = 0;

    expect(await update(fakeSystem())).toBe(1);
    expect(err.join("\n")).toMatch(/releases/i);
    expect(err.join("\n")).not.toMatch(/at Object\.|node:internal/);
  });

  it("points at a version to go back to when the new daemon does not come up", async () => {
    await setup(fakeSystem());
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "linux-x64" });
    err.length = 0;
    const system = fakeSystem();
    system.waitForPort = async () => false;

    expect(await update(system)).toBe(1);
    expect(err.join("\n")).toContain("actana update --version 0.1.0");
  });

  it("rejects --version with no value instead of resolving latest", async () => {
    await setup(fakeSystem());
    expect(await runActanaCli(deps(["update", "--version"], fakeSystem()))).toBe(2);
  });

  it("refuses before setup has run", async () => {
    expect(await runActanaCli(deps(["update"], fakeSystem()))).toBe(1);
    expect(err.join("\n")).toContain("actana setup");
  });
});

describe("uninstall", () => {
  it("stops the daemon and leaves no unit, launcher, or install files", async () => {
    await setup(fakeSystem());
    const layout = layoutForHome();
    const system = fakeSystem();

    expect(await runActanaCli(deps(["uninstall"], system))).toBe(0);

    const commands = system.calls.map((c) => c.join(" "));
    expect(commands).toContain("systemctl --user stop actana-core.service");
    expect(commands).toContain("systemctl --user disable actana-core.service");
    expect(fs.existsSync(layout.servicePath)).toBe(false);
    expect(fs.existsSync(layout.binLink)).toBe(false);
    expect(fs.existsSync(layout.versionsDir)).toBe(false);
    expect(fs.existsSync(layout.currentLink)).toBe(false);
  });

  it("keeps the data dir and the credentials, and says how to remove them", async () => {
    await setup(fakeSystem());
    const layout = layoutForHome();
    out.length = 0;

    await runActanaCli(deps(["uninstall"], fakeSystem()));
    expect(fs.existsSync(layout.dataDir)).toBe(true);
    expect(fs.existsSync(materialFilePath(layout.configDir))).toBe(true);
    expect(out.join("\n")).toContain("--purge-data");
  });

  it("removes the data dir and the credentials with --purge-data", async () => {
    await setup(fakeSystem());
    const layout = layoutForHome();

    expect(await runActanaCli(deps(["uninstall", "--purge-data"], fakeSystem()))).toBe(0);
    expect(fs.existsSync(layout.dataDir)).toBe(false);
    expect(fs.existsSync(layout.configDir)).toBe(false);
    expect(fs.existsSync(layout.root)).toBe(false);
  });

  it("leaves `status` reporting a machine with nothing installed", async () => {
    await setup(fakeSystem());
    await runActanaCli(deps(["uninstall", "--purge-data"], fakeSystem()));
    out.length = 0;

    expect(await runActanaCli(deps(["status"], fakeSystem()))).toBe(1);
    expect(out.join("\n")).toMatch(/not installed/i);
  });

  it("confirms first on a terminal, and does nothing at no", async () => {
    await setup(fakeSystem());
    const layout = layoutForHome();
    const system = fakeSystem();
    system.confirm = async () => false;

    expect(await runActanaCli(deps(["uninstall"], system, { interactive: true }))).toBe(1);
    expect(fs.existsSync(layout.currentLink)).toBe(true);
  });

  it("does not prompt with --yes", async () => {
    await setup(fakeSystem());
    const system = fakeSystem();
    system.confirm = async () => {
      throw new Error("should not have prompted");
    };

    expect(await runActanaCli(deps(["uninstall", "--yes"], system, { interactive: true }))).toBe(0);
  });

  it("succeeds on a machine where nothing was installed", async () => {
    out.length = 0;
    expect(await runActanaCli(deps(["uninstall"], fakeSystem()))).toBe(0);
    expect(out.join("\n")).toMatch(/no Core/i);
  });

  it("rejects an unknown flag rather than removing something unexpected", async () => {
    await setup(fakeSystem());
    expect(await runActanaCli(deps(["uninstall", "--purge-everything"], fakeSystem()))).toBe(2);
    expect(fs.existsSync(layoutForHome().currentLink)).toBe(true);
  });
});

describe("start / stop / restart", () => {
  it.each(["start", "stop", "restart"])("drives systemctl --user %s", async (verb) => {
    await setup(fakeSystem());
    const system = fakeSystem();

    expect(await runActanaCli(deps([verb], system))).toBe(0);
    expect(system.calls.map((c) => c.join(" "))).toContain(
      `systemctl --user ${verb} actana-core.service`,
    );
  });

  it("surfaces a systemctl failure with its message and exit code", async () => {
    await setup(fakeSystem());
    const system = fakeSystem({
      "systemctl --user start": { status: 5, stdout: "", stderr: "Unit not found." },
    });

    expect(await runActanaCli(deps(["start"], system))).toBe(5);
    expect(err.join("\n")).toContain("Unit not found.");
  });

  it("refuses before setup has run", async () => {
    expect(await runActanaCli(deps(["restart"], fakeSystem()))).toBe(1);
    expect(err.join("\n")).toContain("actana setup");
  });
});

describe("logs", () => {
  it("shows the daemon's journal without a pager", async () => {
    await setup(fakeSystem());
    const system = fakeSystem();

    expect(await runActanaCli(deps(["logs"], system))).toBe(0);
    const call = system.calls.find((c) => c[0] === "journalctl")!;
    expect(call).toContain("--user");
    expect(call).toContain("--no-pager");
    expect(call.join(" ")).toContain("-u actana-core.service");
  });

  it("follows with --follow / -f", async () => {
    await setup(fakeSystem());
    const system = fakeSystem();

    await runActanaCli(deps(["logs", "-f"], system));
    expect(system.calls.find((c) => c[0] === "journalctl")).toContain("--follow");
  });

  it("passes a line count through with -n", async () => {
    await setup(fakeSystem());
    const system = fakeSystem();

    await runActanaCli(deps(["logs", "-n", "50"], system));
    expect(system.calls.find((c) => c[0] === "journalctl")!.join(" ")).toContain("--lines 50");
  });

  it("rejects a non-numeric line count", async () => {
    await setup(fakeSystem());
    expect(await runActanaCli(deps(["logs", "-n", "lots"], fakeSystem()))).toBe(2);
  });
});

describe("macOS", () => {
  const MAC_MANIFEST = { ...MANIFEST, target: "mac-arm64", platform: "darwin", arch: "arm64" };

  /** The label as `launchctl print` would report it, running. */
  const RUNNING_HARNESS = [
    "com.actana.core = {",
    "\tstate = running",
    "\tpid = 4211",
    "}",
  ].join("\n");

  let macRoot: string;

  beforeEach(() => {
    macRoot = path.join(tmp, "extract", "actana-core-0.1.0-mac-arm64");
    makeTarballTree(macRoot, MAC_MANIFEST);
  });

  /** CLI deps for a Mac: darwin, arm64, and the mac tarball. */
  function macDeps(argv: string[], system: ActanaSystem, over: Partial<ActanaCliDeps> = {}) {
    return deps(argv, system, {
      platform: "darwin",
      arch: "arm64",
      installRoot: macRoot,
      ...over,
    });
  }

  const plistPath = () => path.join(home, "Library", "LaunchAgents", "com.actana.core.plist");

  async function macSetup(system: ActanaSystem, extra: string[] = []): Promise<number> {
    return runActanaCli(macDeps(["setup", ...extra], system));
  }

  it("installs a LaunchAgent and prints a pairing token", async () => {
    expect(await macSetup(fakeSystem())).toBe(0);

    const text = out.join("\n");
    expect(text).toMatch(/pairing token/i);
    expect(text).toContain("com.actana.core");
    expect(fs.existsSync(plistPath())).toBe(true);
    expect(out.find((line) => decodeRegistrationBlob(line) !== null)).toBeDefined();
  });

  it("tells the operator the daemon starts at login rather than surviving logout", async () => {
    await macSetup(fakeSystem());
    expect(out.join("\n")).toMatch(/starts at login/i);
  });

  it("reports healthy from launchctl, with the LaunchAgent named", async () => {
    await macSetup(fakeSystem());
    out.length = 0;

    const system = fakeSystem({
      "launchctl print gui/501/com.actana.core": {
        status: 0,
        stdout: RUNNING_HARNESS,
        stderr: "",
      },
    });
    expect(await runActanaCli(macDeps(["status"], system))).toBe(0);

    const text = out.join("\n");
    expect(text).toMatch(/healthy/i);
    expect(text).toMatch(/Auto-start\s+com\.actana\.core/);
    expect(text).toMatch(/4211/);
    expect(text).toMatch(/At login/);
    expect(text).not.toMatch(/Linger/);
  });

  it("reports stopped — not degraded — when the agent is installed but unloaded", async () => {
    await macSetup(fakeSystem());
    out.length = 0;

    const system = fakeSystem({
      "launchctl print": { status: 113, stdout: "", stderr: "Could not find service" },
    });
    expect(await runActanaCli(macDeps(["status"], system))).toBe(1);
    expect(out.join("\n")).toMatch(/stopped/i);
  });

  it("stops by unloading the agent — `launchctl stop` would just restart it", async () => {
    await macSetup(fakeSystem());
    const system = fakeSystem({
      "launchctl print gui/501/com.actana.core": {
        status: 0,
        stdout: RUNNING_HARNESS,
        stderr: "",
      },
    });

    expect(await runActanaCli(macDeps(["stop"], system))).toBe(0);
    expect(system.calls.map((c) => c.join(" "))).toContain(
      "launchctl bootout gui/501/com.actana.core",
    );
  });

  it("stopping an already-stopped Core succeeds, as it does on Linux", async () => {
    await macSetup(fakeSystem());
    const system = fakeSystem({
      "launchctl print": { status: 113, stdout: "", stderr: "Could not find service" },
    });

    expect(await runActanaCli(macDeps(["stop"], system))).toBe(0);
    expect(system.calls.map((c) => c.join(" "))).not.toContain(
      "launchctl bootout gui/501/com.actana.core",
    );
  });

  it("starts by bootstrapping the agent back into the domain", async () => {
    await macSetup(fakeSystem());
    const system = fakeSystem({
      "launchctl print gui/501/com.actana.core": {
        status: 113,
        stdout: "",
        stderr: "Could not find service",
      },
    });

    expect(await runActanaCli(macDeps(["start"], system))).toBe(0);
    expect(system.calls.map((c) => c.join(" "))).toContain(
      `launchctl bootstrap gui/501 ${plistPath()}`,
    );
  });

  it("starts a loaded-but-dead agent — loaded is not the same as running", async () => {
    await macSetup(fakeSystem());
    // launchd is throttling a job that keeps crashing: loaded, no pid. On Linux
    // `systemctl start` would act here, so `actana start` must too.
    const system = fakeSystem({
      "launchctl print gui/501/com.actana.core": {
        status: 0,
        stdout: "\tstate = waiting\n",
        stderr: "",
      },
    });

    expect(await runActanaCli(macDeps(["start"], system))).toBe(0);
    expect(system.calls.map((c) => c.join(" "))).toContain(
      "launchctl kickstart -k gui/501/com.actana.core",
    );
  });

  it("starting an already-running Core is a no-op, as it is on Linux", async () => {
    await macSetup(fakeSystem());
    const system = fakeSystem({
      "launchctl print gui/501/com.actana.core": {
        status: 0,
        stdout: RUNNING_HARNESS,
        stderr: "",
      },
    });

    expect(await runActanaCli(macDeps(["start"], system))).toBe(0);
    const commands = system.calls.map((c) => c.join(" "));
    expect(commands.some((c) => c.startsWith("launchctl kickstart"))).toBe(false);
    expect(commands.some((c) => c.startsWith("launchctl bootstrap"))).toBe(false);
  });

  it("restarts a loaded agent in place with kickstart", async () => {
    await macSetup(fakeSystem());
    const system = fakeSystem({
      "launchctl print gui/501/com.actana.core": {
        status: 0,
        stdout: RUNNING_HARNESS,
        stderr: "",
      },
    });

    expect(await runActanaCli(macDeps(["restart"], system))).toBe(0);
    expect(system.calls.map((c) => c.join(" "))).toContain(
      "launchctl kickstart -k gui/501/com.actana.core",
    );
  });

  it("surfaces a launchctl failure with its message and exit code", async () => {
    await macSetup(fakeSystem());
    const system = fakeSystem({
      "launchctl print gui/501/com.actana.core": {
        status: 0,
        stdout: RUNNING_HARNESS,
        stderr: "",
      },
      "launchctl kickstart": { status: 3, stdout: "", stderr: "No such process" },
    });

    expect(await runActanaCli(macDeps(["restart"], system))).toBe(3);
    expect(err.join("\n")).toContain("No such process");
  });

  it("tails the LaunchAgent's log file — launchd has no journal", async () => {
    await macSetup(fakeSystem());
    const system = fakeSystem();

    expect(await runActanaCli(macDeps(["logs"], system))).toBe(0);
    const call = system.calls.find((c) => c[0] === "tail")!;
    expect(call.join(" ")).toBe(
      `tail -n +1 ${path.join(home, "Library", "Logs", "Actana", "core.log")}`,
    );
    expect(system.calls.some((c) => c[0] === "journalctl")).toBe(false);
  });

  it("creates the log file at setup so the first `logs` is not an error", async () => {
    await macSetup(fakeSystem());
    expect(fs.existsSync(path.join(home, "Library", "Logs", "Actana", "core.log"))).toBe(true);
  });

  it("follows and limits lines the same way as on Linux", async () => {
    await macSetup(fakeSystem());
    const system = fakeSystem();

    await runActanaCli(macDeps(["logs", "-f", "-n", "50"], system));
    const call = system.calls.find((c) => c[0] === "tail")!;
    expect(call).toContain("-F");
    expect(call.join(" ")).toContain("-n 50");
  });

  it("updates to a mac build and kickstarts the agent onto it", async () => {
    await macSetup(fakeSystem());
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "mac-arm64" });
    out.length = 0;

    const system = fakeSystem({
      "launchctl print gui/501/com.actana.core": {
        status: 0,
        stdout: RUNNING_HARNESS,
        stderr: "",
      },
    });
    expect(
      await runActanaCli(macDeps(["update", "--base-url", RELEASE_BASE_URL], system)),
    ).toBe(0);

    expect(out.join("\n")).toContain("0.1.0 → 0.2.0");
    expect(system.calls.map((c) => c.join(" "))).toContain(
      "launchctl kickstart -k gui/501/com.actana.core",
    );
  });

  it("will not install a linux build on a Mac", async () => {
    await macSetup(fakeSystem());
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "linux-x64" });
    err.length = 0;

    expect(
      await runActanaCli(macDeps(["update", "--base-url", RELEASE_BASE_URL], fakeSystem())),
    ).toBe(1);
    expect(err.join("\n")).toContain("mac-arm64");
  });

  it("regenerates credentials and reloads the agent onto them", async () => {
    await macSetup(fakeSystem());
    const old = decodeRegistrationBlob(out.find((l) => decodeRegistrationBlob(l) !== null)!)!;
    out.length = 0;

    const system = fakeSystem({
      "launchctl print gui/501/com.actana.core": {
        status: 0,
        stdout: RUNNING_HARNESS,
        stderr: "",
      },
    });
    expect(await runActanaCli(macDeps(["token", "regenerate"], system))).toBe(0);

    expect(decodeRegistrationBlob(out.join("\n").trim())!.caCert).not.toBe(old.caCert);
    expect(system.calls.map((c) => c.join(" "))).toContain(
      "launchctl kickstart -k gui/501/com.actana.core",
    );
  });

  it("uninstalls by booting the agent out and deleting its plist", async () => {
    await macSetup(fakeSystem());
    const layout = layoutForHome("darwin");
    const system = fakeSystem();

    expect(await runActanaCli(macDeps(["uninstall"], system))).toBe(0);

    expect(system.calls.map((c) => c.join(" "))).toContain(
      "launchctl bootout gui/501/com.actana.core",
    );
    expect(fs.existsSync(plistPath())).toBe(false);
    expect(fs.existsSync(layout.binLink)).toBe(false);
    expect(fs.existsSync(layout.versionsDir)).toBe(false);
    // Kept by default, on this platform as on Linux.
    expect(fs.existsSync(materialFilePath(layout.configDir))).toBe(true);
  });

  it("removes the data dir and credentials with --purge-data on a Mac too", async () => {
    await macSetup(fakeSystem());
    const layout = layoutForHome("darwin");

    expect(await runActanaCli(macDeps(["uninstall", "--purge-data"], fakeSystem()))).toBe(0);
    expect(fs.existsSync(layout.dataDir)).toBe(false);
    expect(fs.existsSync(layout.configDir)).toBe(false);
  });
});

describe("unsupported platforms", () => {
  it("says which init systems it does support instead of half-working", async () => {
    expect(await runActanaCli(deps(["setup"], fakeSystem(), { platform: "win32" }))).toBe(1);
    expect(err.join("\n")).toMatch(/win32/);
    expect(err.join("\n")).toMatch(/LaunchAgent/);
    expect(err.join("\n")).not.toMatch(/at Object\.|node:internal/);
  });
});

describe("daemon", () => {
  it("runs the Core in the foreground — this is what the unit execs", async () => {
    await runActanaCli(deps(["daemon"], fakeSystem()));
    expect(daemonRuns).toBe(1);
  });

  it("needs no install: the unit sets the daemon's env itself", async () => {
    expect(await runActanaCli(deps(["daemon"], fakeSystem()))).toBe(0);
    expect(err).toEqual([]);
  });

  it("is not advertised in help — operators use start/stop", async () => {
    await runActanaCli(deps(["--help"], fakeSystem()));
    expect(out.join("\n")).not.toMatch(/^\s+daemon\b/m);
  });
});

// ─── container mode (ADR 0016 D13/D15/D16) ────────────────────────────────

describe("in a container", () => {
  /** The image's baked marker plus whatever the operator's compose file set. */
  function containerEnv(over: Record<string, string> = {}): Record<string, string> {
    return {
      HOME: home,
      PATH: path.join(home, ".local", "bin"),
      ACTANA_CONTAINER: "1",
      ACTANA_PUBLIC_HOST: "core1.example.com",
      AC_CORE_MATERIAL_FILE: path.join(home, "state", "material.json"),
      ...over,
    };
  }

  /** Material as first boot leaves it — the pairing that survives a restart. */
  function writeContainerMaterial(env: Record<string, string>): void {
    const file = env.AC_CORE_MATERIAL_FILE;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        caCert: "ca-cert",
        caKey: "ca-key",
        serverCert: "server-cert",
        serverKey: "server-key",
        clientCert: "client-cert",
        clientKey: "client-key",
        bearerSecret: "a1b2c3d4",
        coreId: "core_container",
      }),
    );
  }

  const REFUSED = ["setup", "start", "stop", "restart", "update", "uninstall", "logs"];

  it.each(REFUSED)("refuses `%s` and names the Docker command that does it", async (verb) => {
    const system = fakeSystem();
    const code = await runActanaCli(deps([verb], system, { env: containerEnv() }));

    expect(code).not.toBe(0);
    expect(err.join("\n")).toContain(`actana ${verb}`);
    expect(err.join("\n")).toMatch(/docker/);
    // Refusing means refusing: no unit is written, nothing is asked of an init
    // system that is not in the image.
    expect(system.calls).toEqual([]);
    expect(fs.existsSync(layoutForHome().servicePath)).toBe(false);
  });

  it("points update at pull-and-recreate rather than at a tree swap", async () => {
    await runActanaCli(deps(["update"], fakeSystem(), { env: containerEnv() }));
    expect(err.join("\n")).toContain("docker compose pull && docker compose up -d");
  });

  it("detects the image by its own marker, never by /.dockerenv", async () => {
    // Without the baked marker this is an ordinary Linux Core, and `start`
    // goes to systemd as it always did.
    const system = fakeSystem();
    await runActanaCli(deps(["start"], system, { env: { HOME: home } }));
    expect(err.join("\n")).not.toMatch(/docker/);
  });

  it("reports status against the container, not against a unit", async () => {
    const env = containerEnv();
    writeContainerMaterial(env);
    const system = fakeSystem();

    expect(await runActanaCli(deps(["status"], system, { env }))).toBe(0);

    const text = out.join("\n");
    expect(text).toMatch(/healthy/i);
    expect(text).toContain("wss://core1.example.com:8443");
    expect(text).toMatch(/restart policy/i);
    expect(text).not.toMatch(/actana-core\.service/);
    expect(system.calls.some((call) => call[0] === "systemctl")).toBe(false);
  });

  it("is stopped, not degraded, when the daemon's port does not answer", async () => {
    const env = containerEnv();
    writeContainerMaterial(env);
    const system = fakeSystem();
    system.waitForPort = async () => false;

    expect(await runActanaCli(deps(["status"], system, { env }))).toBe(1);
    expect(out.join("\n")).toMatch(/stopped/i);
  });

  it("says which variable is missing rather than guessing a public host", async () => {
    const env = containerEnv({ ACTANA_PUBLIC_HOST: "" });
    expect(await runActanaCli(deps(["status"], fakeSystem(), { env }))).toBe(1);
    expect(err.join("\n")).toContain("ACTANA_PUBLIC_HOST");
    // The guess `choosePublicHost` would have made on metal.
    expect(out.join("\n")).not.toContain("10.0.0.5");
  });

  it("reprints a pairing token built from the environment contract", async () => {
    const env = containerEnv({ ACTANA_PORT: "9443", ACTANA_LABEL: "build box" });
    writeContainerMaterial(env);

    expect(await runActanaCli(deps(["token"], fakeSystem(), { env }))).toBe(0);

    const blob = decodeRegistrationBlob(out.join("\n").trim());
    expect(blob?.endpoint).toBe("wss://core1.example.com:9443");
    expect(blob?.label).toBe("build box");
  });

  it("labels the Core with its public host when the operator named no label", async () => {
    const env = containerEnv();
    writeContainerMaterial(env);
    await runActanaCli(deps(["token"], fakeSystem(), { env }));
    expect(decodeRegistrationBlob(out.join("\n").trim())?.label).toBe("core1.example.com");
  });

  it("refuses to boot the daemon without a public host, naming the variable", async () => {
    const env = containerEnv({ ACTANA_PUBLIC_HOST: "" });
    expect(await runActanaCli(deps(["daemon"], fakeSystem(), { env }))).toBe(1);
    expect(err.join("\n")).toContain("ACTANA_PUBLIC_HOST");
    expect(daemonRuns).toBe(0);
  });

  it("hands the daemon the AC_* form of the contract it reads", async () => {
    const env = containerEnv({ ACTANA_PORT: "9443" });
    let handed: Record<string, string> | undefined;
    const code = await runActanaCli(
      deps(["daemon"], fakeSystem(), {
        env,
        runDaemon: async (daemonEnv) => {
          handed = daemonEnv;
        },
      }),
    );

    expect(code).toBe(0);
    expect(handed).toMatchObject({
      AC_CORE_LINK_PORT: "9443",
      AC_CORE_PUBLIC_HOST: "core1.example.com",
      ACTANA_LABEL: "core1.example.com",
    });
  });

  // The default lives in `readContainerContract`, and `core-entry` has its own
  // `process.env.ACTANA_LABEL || ""` fallback — so a daemon handed everything
  // but the label boots with an empty one, and the blob it prints on first run
  // disagrees with the one `actana token` prints for the same Core.
  it("hands the daemon the label default when the operator named none", async () => {
    let handed: Record<string, string> | undefined;
    await runActanaCli(
      deps(["daemon"], fakeSystem(), {
        env: containerEnv(),
        runDaemon: async (daemonEnv) => {
          handed = daemonEnv;
        },
      }),
    );
    expect(handed?.ACTANA_LABEL).toBe("core1.example.com");
  });

  it("hands the daemon the operator's label when they named one", async () => {
    let handed: Record<string, string> | undefined;
    await runActanaCli(
      deps(["daemon"], fakeSystem(), {
        env: containerEnv({ ACTANA_LABEL: "build-box" }),
        runDaemon: async (daemonEnv) => {
          handed = daemonEnv;
        },
      }),
    );
    expect(handed?.ACTANA_LABEL).toBe("build-box");
  });

  it("leaves the daemon's env alone on metal — the unit already set it", async () => {
    let handed: Record<string, string> | undefined;
    await runActanaCli(
      deps(["daemon"], fakeSystem(), {
        runDaemon: async (daemonEnv) => {
          handed = daemonEnv;
        },
      }),
    );
    expect(handed).toEqual({});
  });

  it("still installs a Harness — that verb is the same job in a container", async () => {
    const system = fakeSystem();
    const code = await runActanaCli(
      deps(["harnesses", "install", "claude-code"], system, {
        env: containerEnv(),
        probeHarnesses: () => ({ "claude-code": { status: "available", version: "2.1.0" } }),
      }),
    );
    expect(code).toBe(0);
    expect(system.calls.some((call) => call[0] === "systemctl")).toBe(false);
  });

  it("lists the three variables and the refused verbs in help", async () => {
    await runActanaCli(deps(["--help"], fakeSystem(), { env: containerEnv() }));
    const text = out.join("\n");
    for (const name of ["ACTANA_PUBLIC_HOST", "ACTANA_PORT", "ACTANA_LABEL"]) {
      expect(text).toContain(name);
    }
    for (const verb of REFUSED) {
      expect(text).toMatch(new RegExp(`\\b${verb}\\b`));
    }
  });
});

// ─── Harness detection and offers (installer issue 05) ────────────────────

/** A probe result where nothing is installed — the fresh-VM case. */
const NO_HARNESSES = {
  "claude-code": { status: "missing" as const, reason: "not-found" },
  codex: { status: "missing" as const, reason: "not-found" },
  "cursor-cli": { status: "missing" as const, reason: "not-found" },
  opencode: { status: "missing" as const, reason: "not-found" },
};

/** The vendor installer command lines a run shelled out to, in order. */
function vendorCommands(system: { calls: string[][] }): string[] {
  return system.calls.filter((call) => call[0] === "/bin/sh").map((call) => call[2]);
}

describe("agent offers during setup", () => {
  it("installs nothing and prompts for nothing without a terminal", async () => {
    const system = fakeSystem();
    expect(await runActanaCli(deps(["setup"], system, { probeHarnesses: () => NO_HARNESSES }))).toBe(0);

    expect(vendorCommands(system)).toEqual([]);
    expect(out.join("\n")).toContain("actana harnesses install");
  });

  it("installs exactly the agents named with --with-<harness>", async () => {
    const system = fakeSystem();
    expect(
      await runActanaCli(deps(["setup", "--with-opencode"], system, { probeHarnesses: () => NO_HARNESSES })),
    ).toBe(0);

    expect(vendorCommands(system)).toEqual(["curl -fsSL https://opencode.ai/install | bash"]);
    expect(out.join("\n")).toContain("installed OpenCode");
  });

  it("accepts the CLI command as the flag name too", async () => {
    const system = fakeSystem();
    await runActanaCli(deps(["setup", "--with-claude"], system, { probeHarnesses: () => NO_HARNESSES }));
    expect(vendorCommands(system)).toEqual(["curl -fsSL https://claude.ai/install.sh | bash"]);
  });

  it("installs every missing agent under --yes", async () => {
    const system = fakeSystem();
    await runActanaCli(deps(["setup", "--yes"], system, { probeHarnesses: () => NO_HARNESSES }));
    expect(vendorCommands(system)).toHaveLength(4);
  });

  it("installs nothing under --no-harnesses", async () => {
    const system = fakeSystem();
    await runActanaCli(
      deps(["setup", "--yes", "--no-harnesses"], system, { probeHarnesses: () => NO_HARNESSES }),
    );
    expect(vendorCommands(system)).toEqual([]);
  });

  it("rejects --no-harnesses together with --with-<harness>", async () => {
    const system = fakeSystem();
    expect(
      await runActanaCli(deps(["setup", "--no-harnesses", "--with-codex"], system)),
    ).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("--no-harnesses cannot be combined");
    // Nothing was installed: the run stopped before touching the machine.
    expect(system.calls).toEqual([]);
  });

  it("answers a misspelled agent flag with the supported list", async () => {
    expect(await runActanaCli(deps(["setup", "--with-claud"], fakeSystem()))).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("unknown option: --with-claud");
    expect(err.join("\n")).toContain("claude-code");
  });

  it("offers each missing agent on a terminal", async () => {
    const system = fakeSystem();
    // The first answer is the linger prompt; then one per missing agent.
    system.answers = [true, true, false, false, false];
    await runActanaCli(
      deps(["setup"], system, { interactive: true, probeHarnesses: () => NO_HARNESSES }),
    );
    expect(vendorCommands(system)).toEqual(["curl -fsSL https://claude.ai/install.sh | bash"]);
  });

  it("finishes the install when a vendor installer fails", async () => {
    const system = fakeSystem();
    system.passthroughFailures = { "opencode.ai/install": 1 };
    expect(
      await runActanaCli(deps(["setup", "--with-opencode"], system, { probeHarnesses: () => NO_HARNESSES })),
    ).toBe(0);

    expect(out.join("\n")).toContain("could not install OpenCode");
    // The pairing token still printed — the Core is usable.
    expect(out.join("\n")).toContain("pairing token");
  });
});

describe("actana harnesses install", () => {
  it("installs the named agent with the vendor's own installer", async () => {
    const system = fakeSystem();
    await setup(system);
    out.length = 0;

    expect(
      await runActanaCli(
        deps(["harnesses", "install", "opencode"], system, { probeHarnesses: () => NO_HARNESSES }),
      ),
    ).toBe(0);
    expect(vendorCommands(system)).toEqual(["curl -fsSL https://opencode.ai/install | bash"]);
  });

  it("touches only the agent that was named", async () => {
    const system = fakeSystem();
    await runActanaCli(
      deps(["harnesses", "install", "claude"], system, { probeHarnesses: () => NO_HARNESSES }),
    );
    expect(vendorCommands(system)).toHaveLength(1);
    // No noise about the three agents the operator did not ask about.
    expect(out.join("\n")).not.toContain("harnesses install <id>");
  });

  it("nudges the running daemon so a paired Panel sees the new agent", async () => {
    const system = fakeSystem({ "systemctl --user show": { status: 0, stdout: RUNNING_UNIT, stderr: "" } });
    await setup(system);
    out.length = 0;

    await runActanaCli(
      deps(["harnesses", "install", "codex"], system, { probeHarnesses: () => NO_HARNESSES }),
    );
    expect(system.signals).toEqual([[4211, "SIGHUP"]]);
    expect(out.join("\n")).toContain("re-probed");
  });

  it("says so when the agent is already installed, and installs nothing", async () => {
    const system = fakeSystem();
    expect(
      await runActanaCli(
        deps(["harnesses", "install", "codex"], system, {
          probeHarnesses: () => ({ ...NO_HARNESSES, codex: { status: "available", path: "/usr/bin/codex" } }),
        }),
      ),
    ).toBe(0);
    expect(vendorCommands(system)).toEqual([]);
    expect(out.join("\n")).toContain("already installed");
  });

  it("exits non-zero when the vendor installer fails", async () => {
    const system = fakeSystem();
    system.passthroughFailures = { "cursor.com/install": 1 };
    expect(
      await runActanaCli(
        deps(["harnesses", "install", "cursor-cli"], system, { probeHarnesses: () => NO_HARNESSES }),
      ),
    ).toBe(1);
    expect(out.join("\n")).toContain("https://cursor.com/docs/cli/installation");
  });

  it("answers an unknown id with the supported list", async () => {
    expect(
      await runActanaCli(deps(["harnesses", "install", "gemini"], fakeSystem())),
    ).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("unknown harness: gemini");
    expect(err.join("\n")).toContain("opencode");
  });

  it("needs an id, and needs a subcommand", async () => {
    expect(await runActanaCli(deps(["harnesses", "install"], fakeSystem()))).toBe(EXIT_USAGE);
    expect(await runActanaCli(deps(["harnesses"], fakeSystem()))).toBe(EXIT_USAGE);
    expect(await runActanaCli(deps(["harnesses", "list"], fakeSystem()))).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("unknown subcommand: list");
  });

  it("is advertised in help", async () => {
    await runActanaCli(deps(["--help"], fakeSystem()));
    expect(out.join("\n")).toContain("harnesses install");
    expect(out.join("\n")).toContain("--no-harnesses");
  });
});
