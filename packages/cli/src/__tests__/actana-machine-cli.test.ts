import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { runActanaCli, CLIENT_NOUNS, EXIT_USAGE } from "../actana-cli.ts";
import { loadCoreBlob, registryPaths } from "../blob-registry.ts";
import { localCoreName } from "../local-core-wiring.ts";
import type { ActanaCliDeps } from "../cli-deps.ts";
import { refusedContainerVerbs } from "../actana-container.ts";
import { installDirFor, resolveActanaLayout } from "../actana-layout.ts";
import { readActanaConfig, writeActanaConfig } from "../actana-config.ts";
import { releaseAssetName, releaseChannel } from "../actana-release.ts";
import type { ActanaSystem, CommandResult } from "../actana-system.ts";
import { fakeSystem as makeFakeSystem, realTar, stubClientHalf } from "./machine-fixture.ts";
import { materialFilePath } from "@actana/shared/core-material-store";
import { fixtureFetcher, writeRelease } from "./release-fixture.ts";

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
  return makeFakeSystem(overrides, realTar);
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
let debug: string[];
let daemonRuns: number;

/** A fixed "now" for the update check's once-a-day cache. */
const NOW = 1_700_000_000_000;

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
    // The client half is filled with fakes that refuse: this suite is about the
    // machine verbs, and a verb here that dialled a Core would be news.
    ...stubClientHalf(() => NOW),
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
    now: () => NOW,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    debug: (line) => debug.push(line),
    probeHarnesses: () => ({ claude: { status: "available", version: "2.1.0" } }),
    runDaemon: async () => {
      daemonRuns += 1;
    },
    ...over,
  };
}

/**
 * The credential setup wired into this machine's own registry (#288 D9).
 *
 * Setup emits nothing an operator can carry (#287), so the registry file is
 * where its work lands and this is how the suite reads it back. `label` is what
 * the registry name is derived from, and defaults to the hostname the way
 * setup's does.
 */
function wiredCredential(label = "vm-1") {
  const loaded = loadCoreBlob(registryPaths({ HOME: home }, home), localCoreName(label));
  if (!loaded.ok) throw new Error(`no registry entry for ${label}: ${loaded.error}`);
  return loaded.blob;
}

/** This Core's own identity, as the daemon will load it. */
function readMaterial(platform: NodeJS.Platform = "linux") {
  const file = materialFilePath(layoutForHome(platform).configDir);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
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
  debug = [];
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

  // The vocabulary #287 settled: "pairing code" is the eight characters `pair
  // new` prints, and the artifact the old "pairing token" named does not exist.
  // Neither phrase belongs in the help any more.
  it("says `pairing code`, and neither `pairing token` nor `registration blob`", async () => {
    await runActanaCli(deps(["--help"], fakeSystem()));
    const text = out.join("\n").toLowerCase();
    expect(text).not.toContain("pairing token");
    expect(text).not.toContain("registration blob");
    expect(text).toMatch(/\bpair new\b/);
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

/**
 * The names the help's two command blocks advertise.
 *
 * Two blocks since #288, because there is one help text over one program: the
 * client nouns under *Cores this machine can reach*, and the machine verbs
 * under *This machine's own Core*. A name that fell out of either heading
 * would be a name nobody finds, which is the failure these two tests exist for.
 */
async function documentedNames(): Promise<string[]> {
  out = [];
  await runActanaCli(deps(["--help"], fakeSystem()));
  const text = out.join("\n");
  const names = new Set<string>();
  for (const heading of ["Cores this machine can reach", "This machine's own Core"]) {
    const block = text.split(new RegExp(`^${heading}$`, "m"))[1]?.split(/\n\s*\n/)[0] ?? "";
    expect(block.trim(), `the help has no \`${heading}\` block`).not.toBe("");
    for (const line of block.split("\n")) {
      // Two-space indent, then the name — the continuation row that spells out
      // `token regenerate` re-names `token`, which the set folds away.
      const match = /^ {2}(\w+)/.exec(line);
      if (match) names.add(match[1]);
    }
  }
  return [...names];
}

/**
 * The names the dispatch has a case for: the client nouns, and the machine
 * verbs the trailing `switch` handles.
 *
 * Read off the source because the switch is the only place that knows: a list
 * exported for the test to compare against would be a third thing to keep in
 * sync, which is the bug this guards. A refactor that replaces the switch
 * breaks this loudly rather than quietly passing — a parse that finds nothing
 * asserts that, rather than sliding through on an empty list.
 */
function dispatchedNames(): string[] {
  const source = fs.readFileSync(path.resolve(__dirname, "../actana-cli.ts"), "utf8");
  // The *last* one: the noun switch inside the client branch comes first, and
  // its names are `CLIENT_NOUNS`, which is exported and needs no parsing.
  const start = source.lastIndexOf("switch (head) {");
  expect(start, "the dispatch switch moved — this guard parses `switch (head) {`").toBeGreaterThan(
    -1,
  );
  const body = source.slice(start, source.indexOf("default:", start));
  const verbs = [...body.matchAll(/case "(\w+)":/g)].map((match) => match[1]);
  expect(verbs).toContain("setup");
  return [...CLIENT_NOUNS, ...verbs];
}

describe("help and dispatch stay in sync", () => {
  it("dispatches every name the help advertises", async () => {
    const names = await documentedNames();
    expect(names).toContain("setup");
    expect(names).toContain("session");

    for (const name of names) {
      err = [];
      // A flag no command owns: each one rejects it while parsing, so the
      // command is proven to be dispatched without any of them being run for
      // real.
      await runActanaCli(deps([name, "--not-a-real-flag"], fakeSystem()));
      expect(err.join("\n")).not.toContain(`unknown command "${name}"`);
    }
  });

  it("advertises every name it dispatches, `daemon` excepted", async () => {
    const documented = new Set(await documentedNames());
    // `daemon` is what the unit / LaunchAgent execs, not something an operator
    // types, so it is the one name deliberately left out of the help.
    expect(dispatchedNames().filter((name) => !documented.has(name))).toEqual(["daemon"]);
  });
});

// ─── `actana place` — install without activating (ADR 0036 C2, #316) ────────
//
// The verb `install.sh` hands the bundle to. The script used to end by running
// `actana setup`, so one line both installed a Core and turned the machine
// into one; this is the half that is left when activation is taken out of it.
// What has to hold at this level is the whole of what an operator's next
// command depends on: the bundle is on disk, the launcher is linked, nothing
// is running, and the printed command is one they can actually run.

describe("place", () => {
  /** The layout paths a placement writes, for the scratch home under test. */
  const placed = () => {
    const layout = layoutForHome();
    return { layout, installDir: installDirFor(layout, MANIFEST.version) };
  };

  it("places the bundle, points `current` at it, and links the launcher", async () => {
    expect(await runActanaCli(deps(["place"], fakeSystem()))).toBe(0);

    const { layout, installDir } = placed();
    expect(fs.existsSync(path.join(installDir, "app", "core-entry.cjs"))).toBe(true);
    expect(fs.realpathSync(layout.currentLink)).toBe(fs.realpathSync(installDir));
    expect(fs.readlinkSync(layout.binLink)).toBe(path.join(layout.currentLink, "bin", "actana"));
    expect(out.join("\n")).toContain(installDir);
  });

  // The sentence that stops an operator believing the machine is a Core.
  it("says nothing is running, and prints the command that changes that", async () => {
    await runActanaCli(deps(["place"], fakeSystem()));

    const text = out.join("\n");
    expect(text).toMatch(/not a Core until you set it up/i);
    expect(text).toMatch(/^ {2}actana setup$/m);
    // Once, so there is one command and not two free to disagree — the e2e
    // reads this line back and runs it.
    expect(text.match(/\bactana setup\b/g)).toHaveLength(1);
  });

  // Advice that does not work is worse than no advice: `actana setup --help`
  // is a usage error, because `--help` is a global flag rather than one of
  // setup's own. Whatever `place` points at has to be a command that runs.
  it("names a help command that actually answers", async () => {
    await runActanaCli(deps(["place"], fakeSystem()));
    const advised = /`(actana[^`]*--help)`/.exec(out.join("\n"));
    expect(advised, "place stopped naming a help command").not.toBeNull();

    out.length = 0;
    const argv = advised![1].split(" ").slice(1);
    expect(await runActanaCli(deps(argv, fakeSystem()))).toBe(0);
    expect(out.join("\n")).toMatch(/actana <command>/);
  });

  it("asks the init system for nothing at all", async () => {
    const system = fakeSystem();
    expect(await runActanaCli(deps(["place"], system))).toBe(0);

    // No `systemctl`, no `loginctl`, no `launchctl`: placement is a copy and
    // two symlinks, and a verb that touched the init system would be the
    // removed tail growing back.
    expect(system.calls).toEqual([]);
    const { layout } = placed();
    expect(fs.existsSync(layout.servicePath)).toBe(false);
    expect(fs.existsSync(materialFilePath(layout.configDir))).toBe(false);
    // Nothing was registered with this machine's own CLI either — that is
    // setup's, and it needs a credential that does not exist yet.
    expect(() => wiredCredential()).toThrow();
  });

  // #316's fourth criterion, and the case it exists for: on a fresh machine
  // `~/.local/bin` does not exist at login, so the shell never put it on
  // `PATH`, so a bare `actana setup` is a command that will not be found.
  it("prints an absolute path when the launcher's directory is not on PATH", async () => {
    await runActanaCli(deps(["place"], fakeSystem(), { env: { HOME: home, PATH: "/usr/bin" } }));

    const { layout } = placed();
    const absolute = `${path.join(layout.currentLink, "bin", "actana")} setup`;
    expect(out.join("\n")).toContain(absolute);
    expect(out.join("\n")).not.toMatch(/^ {2}actana setup$/m);
  });

  // The CLI-only install this milestone must not break (#288 / ADR 0032): an
  // `npm i -g @actana/cli` shim sits at exactly `binLink` inside the Core
  // image, because `NPM_CONFIG_PREFIX` makes that directory the npm prefix's
  // bin. Placement reaches that path before setup does now.
  it("does not clobber an `actana` somebody else installed at the same path", async () => {
    const { layout } = placed();
    const shim = path.join(home, ".local", "lib", "node_modules", "@actana", "cli", "bin", "actana.mjs");
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, "#!/usr/bin/env node\n");
    fs.mkdirSync(layout.binDir, { recursive: true });
    fs.symlinkSync(shim, layout.binLink);

    expect(await runActanaCli(deps(["place"], fakeSystem()))).toBe(0);

    expect(fs.readlinkSync(layout.binLink)).toBe(shim);
    const text = out.join("\n");
    expect(text).toContain(layout.binLink);
    // And the printed command goes through this install's own launcher, not
    // through the other program — which has no bundle around it and would
    // download a release rather than activate the one just placed.
    expect(text).toContain(`${path.join(layout.currentLink, "bin", "actana")} setup`);
  });

  // Review finding 7. `claimLauncher` writes nothing at `binLink` when another
  // `actana` is earlier on `PATH` — often there is no such file at all — so a
  // `Launcher <binLink>` row would name a path with nothing at it, three lines
  // under a note saying the launcher was left alone.
  it("does not claim a launcher it did not write", async () => {
    const elsewhere = path.join(home, "usr", "bin");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "actana"), "#!/bin/sh\n");
    const { layout } = placed();

    expect(
      await runActanaCli(
        deps(["place"], fakeSystem(), {
          env: { HOME: home, PATH: `${elsewhere}:${layout.binDir}` },
        }),
      ),
    ).toBe(0);

    expect(fs.existsSync(layout.binLink)).toBe(false);
    const text = out.join("\n");
    expect(text).not.toMatch(new RegExp(`Launcher\\s+${layout.binLink}$`, "m"));
    expect(text).toContain(path.join(elsewhere, "actana"));
    expect(text).toMatch(/Launcher\s+left alone/);
  });

  // Review finding 5. `installTree` renames a fresh tree over `installDir`, so
  // a daemon executing out of *that* directory loses the files behind it —
  // which is the documented "paste both again" upgrade whenever the version
  // has not moved. `runActanaSetup` stops the service first for exactly this;
  // `place` has to as well, or the guard has a hole the size of the new front
  // door.
  it("stops a running Core whose own tree it is about to replace", async () => {
    await runActanaCli(deps(["place"], fakeSystem()));
    out.length = 0;

    const system = fakeSystem({
      "systemctl --user is-active": { status: 0, stdout: "active\n", stderr: "" },
    });
    expect(await runActanaCli(deps(["place"], system))).toBe(0);

    const commands = system.calls.map((call) => call.join(" "));
    expect(commands).toContain("systemctl --user stop actana-core.service");
    expect(out.join("\n")).toMatch(/Stopping the running Core/);
    // And the bundle still landed.
    expect(fs.existsSync(path.join(placed().installDir, "app", "core-entry.cjs"))).toBe(true);
  });

  it("asks the init system nothing when there is no tree at that path to destroy", async () => {
    // The ordinary case — a fresh machine — and the reason the guard above is
    // not simply "always consult the service": `install.sh` runs this on
    // machines whose init system this CLI may not support at all.
    const system = fakeSystem({
      "systemctl --user is-active": { status: 0, stdout: "active\n", stderr: "" },
    });
    expect(await runActanaCli(deps(["place"], system))).toBe(0);
    expect(system.calls).toEqual([]);
  });

  it("stops it through whatever this machine's init system is, not through systemd", async () => {
    // The same guard on the other platform, because the hazard is the
    // filesystem rename and not the init system: a LaunchAgent's job is
    // executing out of the tree being replaced just as a systemd unit's is.
    const mac = { platform: "darwin" as NodeJS.Platform, arch: "arm64" };
    const macManifest = { ...MANIFEST, target: "mac-arm64", platform: "darwin", arch: "arm64" };
    const macRoot = path.join(tmp, "extract-mac", "actana-core-0.1.0-mac-arm64");
    makeTarballTree(macRoot, macManifest);
    await runActanaCli(deps(["place"], fakeSystem(), { ...mac, installRoot: macRoot }));
    out.length = 0;

    const system = fakeSystem({
      "launchctl print": { status: 0, stdout: "state = running\npid = 4211\n", stderr: "" },
    });
    expect(await runActanaCli(deps(["place"], system, { ...mac, installRoot: macRoot }))).toBe(0);

    const commands = system.calls.map((call) => call.join(" "));
    expect(commands.some((command) => command.startsWith("launchctl bootout"))).toBe(true);
    expect(commands.some((command) => command.startsWith("systemctl"))).toBe(false);
    expect(out.join("\n")).toMatch(/Stopping the running Core/);
  });

  // Review finding 6. The unit's `ExecStart` resolves through `current`, so a
  // placement on a machine that is already a Core moves what a restart would
  // start while `actana.json` and `actana status` still describe the old
  // version. Saying so is the difference between an operator who finishes the
  // upgrade and one who reboots into a Core nothing has set up.
  it("says the running Core is still on the old version until setup finishes", async () => {
    await setup(fakeSystem());
    out.length = 0;

    const newer = { ...MANIFEST, version: "0.2.0" };
    const newRoot = path.join(tmp, "extract-2", "actana-core-0.2.0-linux-x64");
    makeTarballTree(newRoot, newer);
    expect(await runActanaCli(deps(["place"], fakeSystem(), { installRoot: newRoot }))).toBe(0);

    const text = out.join("\n");
    expect(text).toMatch(/already set up as a Core on 0\.1\.0/);
    expect(text).toContain("0.2.0");
    expect(text).toMatch(/still running 0\.1\.0/);
    expect(text).toMatch(/finish the upgrade with/);
    // Not the fresh-machine sentence — this machine is a Core, and telling it
    // "nothing is running yet" would be false.
    expect(text).not.toMatch(/Nothing is running yet/);
    expect(text).toMatch(/^ {2}actana setup$/m);
  });

  it("takes no options, and says where the ones it refuses went", async () => {
    expect(await runActanaCli(deps(["place", "--public-host", "10.0.0.7"], fakeSystem()))).toBe(
      EXIT_USAGE,
    );
    expect(err.join("\n")).toContain("--public-host");
    expect(err.join("\n")).toMatch(/actana setup/);
    expect(fs.existsSync(placed().installDir)).toBe(false);
  });

  it("refuses when there is no bundle here, and names the verb that fetches one", async () => {
    // The `npm i -g @actana/cli` shape: a CLI with no tarball around it.
    const code = await runActanaCli(deps(["place"], fakeSystem(), { installRoot: "" }));
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/actana install/);
  });

  it("reports a build for another machine as an error, not a stack trace", async () => {
    const code = await runActanaCli(deps(["place"], fakeSystem(), { arch: "arm64" }));
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/linux-x64/);
    expect(err.join("\n")).not.toMatch(/at Object\.|node:internal/);
    expect(fs.existsSync(placed().installDir)).toBe(false);
  });

  // The two-command install, end to end at this level: place, then set up
  // over what was placed. `setup` finds its own tree as its source, so it
  // copies nothing and the machine ends up exactly where the one-command
  // install used to leave it.
  it("leaves a machine `actana setup` can finish activating", async () => {
    expect(await runActanaCli(deps(["place"], fakeSystem()))).toBe(0);
    out.length = 0;

    const { installDir } = placed();
    expect(await runActanaCli(deps(["setup"], fakeSystem(), { installRoot: installDir }))).toBe(0);

    expect(out.join("\n")).toContain("actana pair new");
    expect(wiredCredential().endpoint).toBe("wss://10.0.0.5:8443");
    expect(fs.existsSync(layoutForHome().servicePath)).toBe(true);
  });
});

describe("setup", () => {
  it("installs, starts, and points the operator at `actana pair new`", async () => {
    expect(await setup(fakeSystem())).toBe(0);

    const text = out.join("\n");
    expect(text).toContain("actana pair new");
    expect(text).not.toMatch(/paste/i);
    // The credential went into this machine's own registry and nowhere else.
    expect(wiredCredential().endpoint).toBe("wss://10.0.0.5:8443");
  });

  // #287, and the assertion the whole ticket turns on: no output sink sees a
  // credential, because there is no artifact for one to be printed as.
  it("prints no credential — not the CA, not the client cert, not the bearer", async () => {
    expect(await setup(fakeSystem())).toBe(0);
    const printed = [...out, ...err].join("\n");
    const blob = wiredCredential();
    for (const secret of [blob.caCert, blob.clientCert, blob.clientKey, blob.bearer]) {
      expect(printed).not.toContain(secret);
    }
    expect(printed).not.toMatch(/BEGIN (CERTIFICATE|PRIVATE KEY)/);
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
    expect(wiredCredential().endpoint).toBe("wss://core.example:8443");
  });

  it("defaults the public host to the machine's routable address", async () => {
    await setup(fakeSystem());
    expect(out.join("\n")).toContain("wss://10.0.0.5:8443");
  });

  it("honours --public-host, --port and --label", async () => {
    await setup(fakeSystem(), ["--public-host", "core.example", "--port", "9443", "--label", "eu-1"]);

    const blob = wiredCredential("eu-1");
    expect(blob.endpoint).toBe("wss://core.example:9443");
    expect(blob.label).toBe("eu-1");
  });

  // #347: one Core, several addresses, one certificate. The flag grew commas;
  // it did not change name, and a single value did not change meaning.
  it("covers every address a comma-separated --public-host names", async () => {
    await setup(fakeSystem(), ["--public-host", "core,10.0.0.5,core.example"]);

    const material = readMaterial();
    const san = new X509Certificate(material.serverCert!).subjectAltName ?? "";
    expect(san).toContain("DNS:core");
    expect(san).toContain("IP Address:10.0.0.5");
    expect(san).toContain("DNS:core.example");
    // The loopback pair every server certificate carries (ADR 0032 D9).
    expect(san).toContain("DNS:localhost");
    expect(san).toContain("IP Address:127.0.0.1");

    // The primary is the endpoint, and the whole list reaches the daemon in the
    // one variable it reads it from.
    expect(wiredCredential().endpoint).toBe("wss://core:8443");
    expect(fs.readFileSync(layoutForHome().servicePath, "utf8")).toContain(
      "AC_CORE_PUBLIC_HOST=core,10.0.0.5,core.example",
    );
    // Printed the way the flag takes it back, so an operator can paste it.
    expect(out.join("\n")).toContain("10.0.0.5,core.example");
  });

  it("tells an operator adding an address that nothing has to be re-paired", async () => {
    // ADR 0038 D3a, end to end through the verb an operator actually runs. On
    // metal this is the only message about the change they ever see: the
    // daemon's next boot reads `covered` and says nothing at all.
    await setup(fakeSystem(), ["--public-host", "10.0.0.5"]);
    out.length = 0;

    expect(await setup(fakeSystem(), ["--public-host", "10.0.0.5,core.lan"])).toBe(0);

    const said = out.join("\n");
    expect(said).toContain("core.lan");
    expect(said).toMatch(/none has to be re-paired/i);
    expect(said).toMatch(/actana pair new --public-host core\.lan/);
    // The `moved` advice this path used to print: re-point a Panel at an
    // address it is already dialling, or pair it again.
    expect(said).not.toMatch(/dialling the address it paired with/i);
    expect(said).not.toMatch(/pair it again/i);
    expect(said).not.toMatch(/Public host changed/i);
  });

  // ─── C1: a bare re-run must not collapse a Core onto a guessed address ──
  //
  // #348 made a bare `actana setup` the advertised remedy in five places while
  // #347 raised what taking that advice costs from one address to the whole
  // list. Defaulting to a guess here re-issues a single-SAN certificate,
  // rewrites the config and the unit, and unpairs every client on every other
  // address — with `pair new --public-host <the old one>` then refusing,
  // because the material no longer lists it.

  it("keeps the recorded addresses when setup is re-run with no --public-host", async () => {
    await setup(fakeSystem(), ["--public-host", "core,10.0.0.5"]);
    out.length = 0;

    expect(await setup(fakeSystem())).toBe(0);

    // The certificate still covers both, and the config and unit still name
    // both — a guess would have left one address and dropped the other.
    const san = new X509Certificate(readMaterial().serverCert!).subjectAltName ?? "";
    expect(san).toContain("DNS:core");
    expect(san).toContain("IP Address:10.0.0.5");
    expect(readMaterial().serverHosts).toEqual(["core", "10.0.0.5"]);
    const config = readActanaConfig(layoutForHome().configDir)!;
    expect(config.publicHosts).toEqual(["core", "10.0.0.5"]);
    expect(config.publicHost).toBe("core");
    expect(fs.readFileSync(layoutForHome().servicePath, "utf8")).toContain(
      "AC_CORE_PUBLIC_HOST=core,10.0.0.5",
    );
    // Not silent about a decision made on the operator's behalf.
    expect(out.join("\n")).toMatch(/Keeping this Core's recorded addresses/);
  });

  it("leaves a client paired to the second address able to pair again after a bare re-run", async () => {
    await setup(fakeSystem(), ["--public-host", "core,10.0.0.5"]);
    await setup(fakeSystem());
    out.length = 0;
    err.length = 0;

    // The membership check reads `material.serverHosts`, so this is the exact
    // thing a collapsed certificate would have broken.
    expect(await runActanaCli(deps(["pair", "new", "--public-host", "10.0.0.5"], fakeSystem()))).toBe(
      0,
    );
  });

  it("still lets an explicit --public-host change the addresses", async () => {
    await setup(fakeSystem(), ["--public-host", "core,10.0.0.5"]);
    out.length = 0;

    expect(await setup(fakeSystem(), ["--public-host", "core.example"])).toBe(0);

    expect(readMaterial().serverHosts).toEqual(["core.example"]);
    expect(readActanaConfig(layoutForHome().configDir)!.publicHosts).toEqual(["core.example"]);
    // The declaration is authoritative, so nothing was "kept".
    expect(out.join("\n")).not.toMatch(/Keeping this Core's recorded/);
  });

  it("still guesses on a machine that has never been set up", async () => {
    // A first-time install has no config to read, and the guess is what makes
    // `actana setup` work with no flags at all.
    expect(await setup(fakeSystem())).toBe(0);

    expect(readActanaConfig(layoutForHome().configDir)!.publicHosts?.length).toBe(1);
    expect(out.join("\n")).not.toMatch(/Keeping this Core's recorded/);
  });

  it("still tells an operator who moved the address that a client is left behind", async () => {
    await setup(fakeSystem(), ["--public-host", "10.0.0.5"]);
    out.length = 0;

    expect(await setup(fakeSystem(), ["--public-host", "10.0.0.9"])).toBe(0);

    const said = out.join("\n");
    expect(said).toMatch(/dialling the address it paired with/i);
  });

  it("writes the same unit and the same endpoint for a single --public-host", async () => {
    await setup(fakeSystem(), ["--public-host", "core.example"]);

    // The compatibility promise, at the layer an operator's compose file and
    // unit meet: one address in, one address out, and no list to notice.
    expect(fs.readFileSync(layoutForHome().servicePath, "utf8")).toContain(
      "AC_CORE_PUBLIC_HOST=core.example",
    );
    expect(wiredCredential().endpoint).toBe("wss://core.example:8443");
    expect(out.join("\n")).not.toContain("Also valid");
  });

  it("refuses a --public-host with an empty entry rather than dropping it", async () => {
    expect(await setup(fakeSystem(), ["--public-host", "core,,10.0.0.5"])).toBe(2);
    expect(err.join("\n")).toContain("--public-host");
    expect(err.join("\n")).toContain("empty entry");
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

  it("reports the legacy unit's own state on Linux, not `not installed` (#348)", async () => {
    // The launchd side got this fallback first; without the matching one here,
    // `Auto-start actana-harness.service` printed over `State not installed`
    // — the self-contradiction the issue opens with, on the other platform.
    await setup(fakeSystem());
    fs.rmSync(layoutForHome().servicePath);
    fs.writeFileSync(
      path.join(layoutForHome().serviceDir, "actana-harness.service"),
      "[Unit]\nDescription=Actana Control Harness\n",
    );
    out.length = 0;

    const system = fakeSystem({
      "systemctl --user show actana-core.service": {
        status: 0,
        stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0",
        stderr: "",
      },
      "systemctl --user show actana-harness.service": {
        status: 0,
        stdout: RUNNING_UNIT,
        stderr: "",
      },
    });
    expect(await runActanaCli(deps(["status"], system))).toBe(1);

    const text = out.join("\n");
    expect(text).toMatch(/Auto-start\s+actana-harness\.service/);
    expect(text).not.toMatch(/State\s+not installed/);
    expect(text).toMatch(/Legacy agent\s+actana-harness\.service is still installed/);
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

// Alert-only, and cheap: `status` names a newer release and the command the
// operator runs, asks the channel at most once a day, and is the same command
// it always was on the day the channel cannot be reached — which is every day
// until 0.1.0 is published.
describe("status: the update check", () => {
  /** A fetcher answering the public channel `checkForUpdate` actually asks. */
  function channelWith(version: string | null) {
    const dir = path.join(tmp, `channel-${version ?? "empty"}`);
    fs.mkdirSync(dir, { recursive: true });
    if (version) writeRelease({ dir, version, target: "linux-x64" });
    return fixtureFetcher(dir, releaseChannel({}));
  }

  const running = () =>
    fakeSystem({
      "systemctl --user show": { status: 0, stdout: RUNNING_UNIT, stderr: "" },
      "loginctl show-user": { status: 0, stdout: "Linger=yes", stderr: "" },
    });

  it("names the newer release and the command that installs it", async () => {
    await setup(fakeSystem());
    out.length = 0;

    const code = await runActanaCli(
      deps(["status"], running(), { fetcher: channelWith("0.2.0") }),
    );

    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/Update\s+0\.2\.0 is available — you're on 0\.1\.0/);
    expect(text).toContain("run: actana update");
  });

  // The live path: `releases/latest` 404s because nothing is published yet.
  it("says nothing at all when the channel has no releases", async () => {
    await setup(fakeSystem());
    out.length = 0;

    const code = await runActanaCli(
      deps(["status"], running(), { fetcher: channelWith(null) }),
    );

    expect(code).toBe(0);
    expect(out.join("\n")).not.toMatch(/Update/);
    expect(err).toEqual([]);
    expect(debug.join("\n")).toMatch(/404/);
  });

  it("leaves the health verdict and the exit code alone", async () => {
    await setup(fakeSystem());
    out.length = 0;

    const system = fakeSystem({
      "systemctl --user show": {
        status: 0,
        stdout: "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0",
        stderr: "",
      },
    });
    const code = await runActanaCli(deps(["status"], system, { fetcher: channelWith("0.2.0") }));

    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/stopped/i);
  });

  it("asks the channel once a day, however often status is run", async () => {
    await setup(fakeSystem());
    const fetcher = channelWith("0.2.0");
    const latestUrl = "https://api.github.com/repos/actana/control/releases/latest";

    await runActanaCli(deps(["status"], running(), { fetcher }));
    await runActanaCli(deps(["status"], running(), { fetcher, now: () => NOW + 3_600_000 }));

    expect(fetcher.asked.filter((url) => url === latestUrl)).toHaveLength(1);
  });

  it("asks again once the cached answer is a day old", async () => {
    await setup(fakeSystem());
    const fetcher = channelWith("0.2.0");
    const latestUrl = "https://api.github.com/repos/actana/control/releases/latest";

    await runActanaCli(deps(["status"], running(), { fetcher }));
    await runActanaCli(
      deps(["status"], running(), { fetcher, now: () => NOW + 24 * 60 * 60 * 1000 }),
    );

    expect(fetcher.asked.filter((url) => url === latestUrl)).toHaveLength(2);
  });

  it("makes no request at all when the operator opted out", async () => {
    await setup(fakeSystem());
    out.length = 0;
    const fetcher = channelWith("0.2.0");

    await runActanaCli(
      deps(["status"], running(), {
        fetcher,
        env: {
          HOME: home,
          PATH: path.join(home, ".local", "bin"),
          ACTANA_UPDATE_CHECK: "0",
        },
      }),
    );

    expect(fetcher.asked).toEqual([]);
    expect(out.join("\n")).not.toMatch(/Update/);
  });

  it("says nothing on a machine setup never ran on", async () => {
    const fetcher = channelWith("0.2.0");
    await runActanaCli(deps(["status"], fakeSystem(), { fetcher }));

    expect(fetcher.asked).toEqual([]);
    expect(out.join("\n")).toMatch(/not installed/i);
  });
});

// `actana token` on its own reprinted the hand-carried blob. #287 deleted the
// artifact, so the verb has nothing to print and says so — it must not quietly
// become `regenerate`, which locks every paired client out.
describe("token", () => {
  it("refuses on its own and names the code flow instead", async () => {
    await setup(fakeSystem());
    out.length = 0;
    err.length = 0;

    expect(await runActanaCli(deps(["token"], fakeSystem()))).toBe(EXIT_USAGE);
    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain("actana pair new");
    expect(err.join("\n")).toContain("actana core pair");
  });

  it("prints no credential when it refuses", async () => {
    await setup(fakeSystem());
    const blob = wiredCredential();
    out.length = 0;
    err.length = 0;

    await runActanaCli(deps(["token"], fakeSystem()));
    const printed = [...out, ...err].join("\n");
    for (const secret of [blob.caCert, blob.clientCert, blob.clientKey, blob.bearer]) {
      expect(printed).not.toContain(secret);
    }
  });

  it("rejects a verb under it that is not `regenerate`", async () => {
    expect(await runActanaCli(deps(["token", "reprint"], fakeSystem()))).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("regenerate");
  });
});

// ─── pair (#283) ────────────────────────────────────────────────────────────
//
// `actana-pair.test.ts` is where the three verbs are exercised. What is here is
// the other question, and it is the one #288 exists over: does the verb an
// operator reads about in `actana --help` actually answer on this binary, on
// the machine that has the Core. The suite reaches it the long way round —
// through `runActanaCli`, after a real `setup` — so a `pair` wired into the
// help and not into the dispatch would fail here.

describe("pair", () => {
  it("reaches the Core-side pairing verbs through the real dispatch", async () => {
    await setup(fakeSystem());
    out.length = 0;
    err.length = 0;

    expect(await runActanaCli(deps(["pair", "new", "--label", "laptop"], fakeSystem()))).toBe(0);
    expect(out.join("\n")).toMatch(/^Pairing code\s+[A-Z2-9]{4}-[A-Z2-9]{4}$/m);
    expect(out.join("\n")).toMatch(/^CA fingerprint\s+[0-9A-F]{2}(:[0-9A-F]{2}){31}$/m);
  });

  it("writes the session beside the material, where the daemon reads it", async () => {
    await setup(fakeSystem());
    await runActanaCli(deps(["pair", "new", "--label", "laptop"], fakeSystem()));
    const pairingFile = path.join(layoutForHome().configDir, "pairing.json");
    expect(fs.existsSync(pairingFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(pairingFile, "utf8")).sessions).toHaveLength(1);
  });

  it("lists what it minted, without the code", async () => {
    await setup(fakeSystem());
    await runActanaCli(deps(["pair", "new", "--label", "laptop"], fakeSystem()));
    const code = out.join("\n").match(/Pairing code\s+(\S+)/)![1]!;
    out.length = 0;

    expect(await runActanaCli(deps(["pair", "ls"], fakeSystem()))).toBe(0);
    expect(out.join("\n")).toContain("laptop");
    expect(out.join("\n")).not.toContain(code);
  });

  it("says which machine it is for, in the top-level help and its own", async () => {
    await runActanaCli(deps(["--help"], fakeSystem()));
    expect(out.join("\n")).toMatch(/^\s+pair\b/m);
    expect(out.join("\n")).toMatch(/actana core pair.*client end/);
    out.length = 0;

    await runActanaCli(deps(["pair", "--help"], fakeSystem()));
    expect(out.join("\n")).toMatch(/You are on the Core/);
  });

  it("fails clearly when nothing is installed", async () => {
    expect(await runActanaCli(deps(["pair", "ls"], fakeSystem()))).toBe(1);
    expect(err.join("\n")).toContain("actana setup");
  });
});

describe("token regenerate", () => {
  it("mints an identity no previously paired client can match", async () => {
    await setup(fakeSystem());
    const old = readMaterial();
    out.length = 0;
    err.length = 0;

    expect(await runActanaCli(deps(["token", "regenerate"], fakeSystem()))).toBe(0);

    // Every credential a client pinned is replaced: a client cert signed by the
    // old CA is not signed by this one, so no credential issued before this can
    // complete the mTLS handshake against the daemon that now serves these.
    const fresh = readMaterial();
    expect(fresh.caCert).not.toBe(old.caCert);
    expect(fresh.caKey).not.toBe(old.caKey);
    expect(fresh.bearerSecret).not.toBe(old.bearerSecret);
    expect(fresh.coreId).not.toBe(old.coreId);
  });

  it("hands nothing out — it says to pair again, and prints no credential", async () => {
    await setup(fakeSystem());
    out.length = 0;
    err.length = 0;

    await runActanaCli(deps(["token", "regenerate"], fakeSystem()));
    expect(out).toHaveLength(0);
    expect(err.join("\n")).toMatch(/locked out/i);
    expect(err.join("\n")).toContain("actana pair new");
    // The step that makes the advice followable. A Panel already registered at
    // this endpoint — which is every Panel this sentence is addressed to —
    // refuses the pairing *before* it spends the code, so an operator who does
    // as they are told loses a one-time code and learns nothing.
    expect(err.join("\n")).toMatch(/remove the Core first/i);
    expect(err.join("\n")).toContain("actana core pair");
    const fresh = readMaterial();
    const printed = [...out, ...err].join("\n");
    expect(printed).not.toContain(fresh.caCert);
    expect(printed).not.toContain(fresh.clientKey);
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

  it("restarts a unit systemd still holds after its file was deleted by hand", async () => {
    // #353 review C2, end to end through the real systemd manager. `observe()`
    // is allowed to answer from the filesystem alone when no legacy unit is in
    // play, so without the fallback in `runActanaUpdate` this machine swaps the
    // tree, skips the restart, and leaves the old daemon running out of the new
    // one. Before #348 the restart was unconditional and this worked.
    await setup(fakeSystem());
    fs.rmSync(layoutForHome().servicePath);
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "linux-x64" });
    out.length = 0;
    err.length = 0;

    // The unit file is gone; systemd still has the unit loaded and running.
    const system = fakeSystem({
      "systemctl --user show": { status: 0, stdout: RUNNING_UNIT, stderr: "" },
    });
    expect(await update(system)).toBe(0);

    expect(system.calls.map((c) => c.join(" "))).toContain(
      "systemctl --user restart actana-core.service",
    );
    expect(out.join("\n")).not.toMatch(/no auto-start service/);
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
    const before = readMaterial();
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "linux-x64" });
    out.length = 0;
    await update(fakeSystem());
    expect(out.join("\n")).toMatch(/unchanged|stay paired/i);

    // Read off the material rather than out of a reprint: #287 removed the
    // reprint, and the material file is what a paired client's certificate
    // chains to anyway.
    expect(readMaterial().caCert).toBe(before.caCert);
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

  it("tells the truth on a machine that has only the pre-rename unit", async () => {
    // #353 review C4, end to end. `uninstall` runs without requiring an
    // install, so this machine is reachable — and it is the #348 cleanup path.
    // Both halves have to be said: no Core was installed, *and* the stale unit
    // that was here is gone.
    const layout = layoutForHome();
    fs.mkdirSync(layout.serviceDir, { recursive: true });
    fs.writeFileSync(
      path.join(layout.serviceDir, "actana-harness.service"),
      "[Unit]\nDescription=Actana Control Harness\n",
    );
    out.length = 0;

    expect(await runActanaCli(deps(["uninstall", "--yes"], fakeSystem()))).toBe(0);

    const said = out.join("\n");
    expect(said).toContain("actana-harness.service");
    expect(said).toContain("There was no Core installed for this user");
    // The sentence that used to name a service and an install that were never
    // on this machine.
    expect(said).not.toMatch(/Removed the actana-core\.service service/);
    expect(fs.existsSync(path.join(layout.serviceDir, "actana-harness.service"))).toBe(false);
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

  /** launchd's answer about a job it has never heard of. */
  const NO_SUCH_JOB: CommandResult = { status: 113, stdout: "", stderr: "Could not find service" };

  /**
   * The ordinary Mac: one that never had a pre-rename agent.
   *
   * The shared fake answers 0 to every command it was not told about, and
   * since #348 the launchd manager asks `launchctl print` about
   * `com.actana.harness` — so without this default every machine in this suite
   * would claim to be carrying a legacy agent it never had. Overriding that
   * answer is how a test opts into the machine that does.
   */
  function macSystem(overrides: Record<string, CommandResult> = {}) {
    return fakeSystem({
      "launchctl print gui/501/com.actana.harness": NO_SUCH_JOB,
      ...overrides,
    });
  }

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

  it("installs a LaunchAgent and points the operator at `actana pair new`", async () => {
    expect(await macSetup(macSystem())).toBe(0);

    const text = out.join("\n");
    expect(text).toContain("actana pair new");
    expect(text).toContain("com.actana.core");
    expect(fs.existsSync(plistPath())).toBe(true);
    expect(text).not.toMatch(/BEGIN (CERTIFICATE|PRIVATE KEY)/);
  });

  it("tells the operator the daemon starts at login rather than surviving logout", async () => {
    await macSetup(macSystem());
    expect(out.join("\n")).toMatch(/starts at login/i);
  });

  it("reports healthy from launchctl, with the LaunchAgent named", async () => {
    await macSetup(macSystem());
    out.length = 0;

    const system = macSystem({
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
    await macSetup(macSystem());
    out.length = 0;

    const system = macSystem({
      "launchctl print": { status: 113, stdout: "", stderr: "Could not find service" },
    });
    expect(await runActanaCli(macDeps(["status"], system))).toBe(1);
    expect(out.join("\n")).toMatch(/stopped/i);
  });

  it("stops by unloading the agent — `launchctl stop` would just restart it", async () => {
    await macSetup(macSystem());
    const system = macSystem({
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
    await macSetup(macSystem());
    const system = macSystem({
      "launchctl print": { status: 113, stdout: "", stderr: "Could not find service" },
    });

    expect(await runActanaCli(macDeps(["stop"], system))).toBe(0);
    expect(system.calls.map((c) => c.join(" "))).not.toContain(
      "launchctl bootout gui/501/com.actana.core",
    );
  });

  it("starts by bootstrapping the agent back into the domain", async () => {
    await macSetup(macSystem());
    const system = macSystem({
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
    await macSetup(macSystem());
    // launchd is throttling a job that keeps crashing: loaded, no pid. On Linux
    // `systemctl start` would act here, so `actana start` must too.
    const system = macSystem({
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
    await macSetup(macSystem());
    const system = macSystem({
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
    await macSetup(macSystem());
    const system = macSystem({
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
    await macSetup(macSystem());
    const system = macSystem({
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
    await macSetup(macSystem());
    const system = macSystem();

    expect(await runActanaCli(macDeps(["logs"], system))).toBe(0);
    const call = system.calls.find((c) => c[0] === "tail")!;
    expect(call.join(" ")).toBe(
      `tail -n +1 ${path.join(home, "Library", "Logs", "Actana", "core.log")}`,
    );
    expect(system.calls.some((c) => c[0] === "journalctl")).toBe(false);
  });

  it("creates the log file at setup so the first `logs` is not an error", async () => {
    await macSetup(macSystem());
    expect(fs.existsSync(path.join(home, "Library", "Logs", "Actana", "core.log"))).toBe(true);
  });

  it("follows and limits lines the same way as on Linux", async () => {
    await macSetup(macSystem());
    const system = macSystem();

    await runActanaCli(macDeps(["logs", "-f", "-n", "50"], system));
    const call = system.calls.find((c) => c[0] === "tail")!;
    expect(call).toContain("-F");
    expect(call.join(" ")).toContain("-n 50");
  });

  it("updates to a mac build and kickstarts the agent onto it", async () => {
    await macSetup(macSystem());
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "mac-arm64" });
    out.length = 0;

    const system = macSystem({
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

  // ─── a machine upgraded in place from before the rename (#348) ──────────

  /** What an install generation before the rename left in `~/Library/LaunchAgents`. */
  function plantLegacyAgent(): string {
    const dir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(dir, { recursive: true });
    const legacyPlist = path.join(dir, "com.actana.harness.plist");
    fs.writeFileSync(legacyPlist, "<plist/>\n");
    return legacyPlist;
  }

  it("setup boots the pre-rename agent out and deletes its plist", async () => {
    const legacyPlist = plantLegacyAgent();
    const system = macSystem();

    expect(await macSetup(system)).toBe(0);

    expect(system.calls.map((c) => c.join(" "))).toContain(
      "launchctl bootout gui/501/com.actana.harness",
    );
    expect(fs.existsSync(legacyPlist)).toBe(false);
    expect(out.join("\n")).toMatch(/Removed com\.actana\.harness/);
  });

  it("place warns about it, because `install.sh` never reaches setup", async () => {
    plantLegacyAgent();

    expect(await runActanaCli(macDeps(["place"], macSystem()))).toBe(0);

    // Warned, not removed: `place` puts a tree down and says what to run next.
    expect(err.join("\n")).toMatch(/com\.actana\.harness is still installed/);
    expect(err.join("\n")).toMatch(/actana setup/);
    expect(fs.existsSync(path.join(home, "Library", "LaunchAgents", "com.actana.harness.plist")))
      .toBe(true);
  });

  it("status names the agent launchd loaded and says to run setup", async () => {
    await macSetup(macSystem());
    plantLegacyAgent();
    out.length = 0;

    const system = macSystem({
      "launchctl print gui/501/com.actana.core": {
        status: 0,
        stdout: RUNNING_HARNESS,
        stderr: "",
      },
      "launchctl print gui/501/com.actana.harness": { status: 0, stdout: "", stderr: "" },
    });
    // Non-zero: a second Core-era service on the machine is a degradation, and
    // a script watching the exit code should see it.
    expect(await runActanaCli(macDeps(["status"], system))).toBe(1);

    const text = out.join("\n");
    expect(text).toMatch(/Legacy agent\s+com\.actana\.harness is still installed/);
    expect(text).toMatch(/actana setup/);
  });

  it("update removes it before restarting onto the new tree", async () => {
    await macSetup(macSystem());
    plantLegacyAgent();
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "mac-arm64" });
    out.length = 0;

    const system = macSystem();
    expect(
      await runActanaCli(macDeps(["update", "--base-url", RELEASE_BASE_URL], system)),
    ).toBe(0);

    const commands = system.calls.map((c) => c.join(" "));
    expect(commands).toContain("launchctl bootout gui/501/com.actana.harness");
    // Before the restart: the old agent runs `current/bin/actana` too, and
    // `current` now points at the tree the restart is about to start.
    expect(commands.indexOf("launchctl bootout gui/501/com.actana.harness")).toBeLessThan(
      commands.lastIndexOf("launchctl kickstart -k gui/501/com.actana.core"),
    );
    expect(
      fs.existsSync(path.join(home, "Library", "LaunchAgents", "com.actana.harness.plist")),
    ).toBe(false);
  });

  it("update keeps the legacy agent when it is the machine's only service", async () => {
    // End to end on the #348 Mac, through the real launchd manager: an
    // in-place upgrade where `actana setup` was never run after the rename, so
    // there is no `com.actana.core.plist` to restart onto. Before this, update
    // booted the legacy agent out and then threw on a bootstrap of a plist
    // that does not exist — zero auto-start services, and a message pointing
    // at the logs of a daemon that never started.
    const legacyPlist = plantLegacyAgent();
    // An install `actana place` made: a config and a tree, but no service.
    writeActanaConfig(layoutForHome("darwin").configDir, {
      version: MANIFEST.version,
      port: 8443,
      host: "0.0.0.0",
      publicHost: "10.0.0.5",
      publicHosts: ["10.0.0.5"],
      label: "mac-1",
      installDir: installDirFor(layoutForHome("darwin"), MANIFEST.version),
      dataDir: layoutForHome("darwin").dataDir,
    });
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "mac-arm64" });
    out.length = 0;
    err.length = 0;

    const system = macSystem({ "launchctl print gui/501/": NO_SUCH_JOB });
    const code = await runActanaCli(macDeps(["update", "--base-url", RELEASE_BASE_URL], system));

    // The agent that was the machine's only service is still there.
    expect(fs.existsSync(legacyPlist)).toBe(true);
    expect(system.calls.map((c) => c.join(" "))).not.toContain(
      "launchctl bootout gui/501/com.actana.harness",
    );
    // Non-zero, and pointing at the command that actually registers a Core —
    // not at the logs of something that was never started.
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/actana setup/);
    expect(err.join("\n")).not.toMatch(/Check `actana logs`/);
  });

  it("will not install a linux build on a Mac", async () => {
    await macSetup(macSystem());
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "linux-x64" });
    err.length = 0;

    expect(
      await runActanaCli(macDeps(["update", "--base-url", RELEASE_BASE_URL], macSystem())),
    ).toBe(1);
    expect(err.join("\n")).toContain("mac-arm64");
  });

  it("regenerates credentials and reloads the agent onto them", async () => {
    await macSetup(macSystem());
    const old = readMaterial("darwin");
    out.length = 0;

    const system = macSystem({
      "launchctl print gui/501/com.actana.core": {
        status: 0,
        stdout: RUNNING_HARNESS,
        stderr: "",
      },
    });
    expect(await runActanaCli(macDeps(["token", "regenerate"], system))).toBe(0);

    expect(readMaterial("darwin").caCert).not.toBe(old.caCert);
    expect(system.calls.map((c) => c.join(" "))).toContain(
      "launchctl kickstart -k gui/501/com.actana.core",
    );
  });

  it("uninstalls by booting the agent out and deleting its plist", async () => {
    await macSetup(macSystem());
    const layout = layoutForHome("darwin");
    const system = macSystem();

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
    await macSetup(macSystem());
    const layout = layoutForHome("darwin");

    expect(await runActanaCli(macDeps(["uninstall", "--purge-data"], macSystem()))).toBe(0);
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

  // Derived from the source of truth (`DOCKER_EQUIVALENT`), not retyped. A
  // hardcoded copy here is bound to nothing: a verb added to the refusal table
  // would go untested, and one removed from it would keep passing against a
  // list that no longer describes the CLI.
  const REFUSED = refusedContainerVerbs();

  it("refuses a verb set that is neither empty nor the whole CLI", () => {
    // A floor and a ceiling on the derivation above, so an accidental `{}` or
    // a table that swallowed every verb is a red test rather than a suite that
    // silently checks nothing.
    expect(REFUSED).toContain("setup");
    expect(REFUSED).toContain("update");
    // `install` is on it for exactly `setup`'s reason (#288 D8): it is the verb
    // that puts a Core on this machine, and in the image the machine already
    // is one.
    expect(REFUSED).toContain("install");
    // The verbs that must keep working inside the image.
    expect(REFUSED).not.toContain("status");
    expect(REFUSED).not.toContain("token");
    expect(REFUSED).not.toContain("harnesses");
    // **And every client noun**, which is criterion 3 of #288 bound to the
    // refusal *table* rather than only to the dispatch order that currently
    // keeps them out of it. `actana core ls` and `actana session …` have to
    // work on a container Core with no `npm install`, because the Core
    // installs a skill onto its own machine that teaches them. A noun that
    // appeared here would make that skill dishonest again, and it would do it
    // one table entry at a time.
    for (const noun of CLIENT_NOUNS) {
      expect(REFUSED, `\`${noun}\` is a client noun and must never be refused`).not.toContain(noun);
    }
  });

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

  // The remedy is the only half of the availability line that differs by how
  // this Core arrived: there is no tree to swap in the image, so the command
  // belongs to the operator's host (ADR 0016 D16).
  it("points the update line at the compose commands, not at `actana update`", async () => {
    const env = containerEnv();
    writeContainerMaterial(env);
    const channel = path.join(tmp, "container-channel");
    fs.mkdirSync(channel, { recursive: true });
    writeRelease({ dir: channel, version: "0.2.0", target: "linux-x64" });

    await runActanaCli(
      deps(["status"], fakeSystem(), { env, fetcher: fixtureFetcher(channel, releaseChannel({})) }),
    );

    const text = out.join("\n");
    expect(text).toMatch(/Update\s+0\.2\.0 is available/);
    expect(text).toContain("run: docker compose pull && docker compose up -d");
    expect(text).not.toContain("run: actana update");
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

  // The environment contract used to be observed through the token this Core
  // reprinted. #287 deleted the reprint, so the observable is `status`, which
  // reads the same three variables through the same `endpointFor`.
  it("builds its endpoint from the environment contract", async () => {
    const env = containerEnv({ ACTANA_PORT: "9443", ACTANA_LABEL: "build box" });
    writeContainerMaterial(env);

    expect(await runActanaCli(deps(["status"], fakeSystem(), { env }))).toBe(0);
    expect(out.join("\n")).toContain("wss://core1.example.com:9443");
  });

  it("has no token to reprint, and says how a client enrolls instead", async () => {
    const env = containerEnv();
    writeContainerMaterial(env);
    expect(await runActanaCli(deps(["token"], fakeSystem(), { env }))).toBe(EXIT_USAGE);
    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain("actana pair new");
  });

  // The container path says the same thing about re-pairing as the metal path,
  // and it has to carry the same caveat: a Panel refuses at an endpoint it
  // already holds, and `docker compose restart` does not move the endpoint.
  it("names the restart it owes and the removal a Panel needs, after regenerate", async () => {
    const env = containerEnv();
    writeContainerMaterial(env);

    expect(await runActanaCli(deps(["token", "regenerate"], fakeSystem(), { env }))).toBe(0);

    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain("docker compose restart");
    expect(err.join("\n")).toContain("actana pair new");
    expect(err.join("\n")).toMatch(/remove the Core first/i);
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

  // Scoped to the container page rather than to the whole `--help` output, and
  // that is the entire point of the test. `--help` in the image prints
  // CONTAINER_USAGE *followed by* the ordinary USAGE, whose Commands block
  // already lists setup/start/stop/restart/update/uninstall/logs — so a
  // whole-output match passes even if the container page's verb line is
  // blanked. The split is on USAGE's own first line, which is the boundary
  // between the two pages.
  const containerPage = (): string => {
    const text = out.join("\n");
    const boundary = text.indexOf("actana — drive AI coding agents");
    expect(boundary, "the ordinary USAGE did not follow the container page").toBeGreaterThan(0);
    return text.slice(0, boundary);
  };

  it("lists the three variables and the refused verbs on the container page", async () => {
    await runActanaCli(deps(["--help"], fakeSystem(), { env: containerEnv() }));
    const page = containerPage();

    for (const name of ["ACTANA_PUBLIC_HOST", "ACTANA_PORT", "ACTANA_LABEL"]) {
      expect(page).toContain(name);
    }
    for (const verb of REFUSED) {
      expect(page, `\`${verb}\` is refused but not named on the container page`).toMatch(
        new RegExp(`\\b${verb}\\b`),
      );
    }
  });

  it("prints the container page only inside the image", async () => {
    await runActanaCli(deps(["--help"], fakeSystem(), { env: { HOME: home } }));
    expect(out.join("\n")).not.toContain("its lifecycle belongs to Docker");
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
    // The install finished and said how to enroll a client — the Core is usable.
    expect(out.join("\n")).toContain("actana pair new");
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

// ─── Version skew, tolerated and reported (#288 D10) ────────────────────────
//
// One binary now manages an install it did not necessarily ship with. The rule
// is *tolerate and report*: print both versions, and refuse nothing over the
// difference. Pinning would let a global `npm update` break a running Core on a
// machine where the operator did nothing but update a client.

describe("a Core on a different version from the CLI managing it", () => {
  /** Install, then rewrite the install's manifest to a version this CLI is not. */
  async function installOlderCore(system: ActanaSystem): Promise<string> {
    expect(await setup(system)).toBe(0);
    const layout = layoutForHome();
    const manifestPath = path.join(
      installDirFor(layout, MANIFEST.version),
      "core-manifest.json",
    );
    const older = { ...MANIFEST, version: "0.0.9" };
    fs.writeFileSync(manifestPath, JSON.stringify(older, null, 2) + "\n");
    return older.version;
  }

  /** A system whose unit reports as running, so `status` exits 0. */
  const runningSystem = () =>
    fakeSystem({ "systemctl --user show": { status: 0, stdout: RUNNING_UNIT, stderr: "" } });

  it("prints both versions and says which `actana` is which", async () => {
    const system = runningSystem();
    const older = await installOlderCore(system);
    out = [];

    expect(await runActanaCli(deps(["status"], system))).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(older);
    expect(text).toMatch(/CLI version/);
  });

  it("answers `--version` with both, on two lines", async () => {
    const system = fakeSystem();
    const older = await installOlderCore(system);
    out = [];

    expect(await runActanaCli(deps(["--version"], system))).toBe(0);
    expect(out[0]).toMatch(/^actana \d/);
    expect(out.join("\n")).toContain(`Core installed here: ${older}`);
  });

  it("refuses nothing over the difference", async () => {
    // The half that is a *rule* rather than a row. Every local verb still runs
    // against an install on another version, and each reads that install's own
    // manifest rather than assuming this CLI's.
    const system = runningSystem();
    await installOlderCore(system);

    for (const verb of ["status", "start", "logs"]) {
      err = [];
      const code = await runActanaCli(deps([verb], system));
      expect(err.join("\n"), verb).not.toMatch(/version/i);
      expect(code, verb).toBe(0);
    }
  });
});
