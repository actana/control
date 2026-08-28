import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readActanaConfig, writeActanaConfig, type ActanaConfig } from "../actana-config";
import { installDirFor, resolveActanaLayout, type ActanaLayout } from "../actana-layout";
import { readCoreManifest } from "../actana-manifest";
import { releaseChannel, releaseAssetName } from "../actana-release";
import type {
  ActanaServiceManager,
  ActanaServiceState,
  ServiceVerb,
} from "../actana-service";
import type { ActanaSystem, CommandResult } from "../actana-system";
import { pointSymlink } from "../actana-tree";
import { runActanaUpdate } from "../actana-update";
import { fixtureFetcher, writeRelease, writeTarballTree } from "./release-fixture";

const CHANNEL = releaseChannel({ baseUrl: "http://releases.test" });
const TARGET = "linux-x64";
const INSTALLED_VERSION = "0.1.0";

let tmp: string;
let home: string;
let releaseDir: string;
let layout: ActanaLayout;
let out: string[];

/** A service manager that records its verbs instead of driving an init system. */
function fakeService(overrides: Partial<ActanaServiceManager> = {}) {
  const verbs: ServiceVerb[] = [];
  const service: ActanaServiceManager & { verbs: ServiceVerb[]; stops: number } = {
    verbs,
    stops: 0,
    kind: "systemd",
    name: "actana-core.service",
    filePath: path.join(home, "unit.service"),
    isActive: () => true,
    stop() {
      service.stops += 1;
    },
    install() {},
    uninstall() {},
    removeLegacyUnit: () => null,
    observe: () => ({ name: "actana-core.service", legacyName: null }),
    async ensurePersistence() {
      return { survivesLogout: true, summary: "enabled, lingering" };
    },
    enableAndStart() {},
    state: (): ActanaServiceState | null => ({
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      mainPid: 42,
    }),
    verb(verb): CommandResult {
      verbs.push(verb);
      return { status: 0, stdout: "", stderr: "" };
    },
    persistence: () => ({ label: "Linger", value: "yes" }),
    logs: () => ({ command: "journalctl", args: [] }),
    ...overrides,
  };
  return service;
}

function fakeSystem(overrides: Partial<ActanaSystem> = {}) {
  const calls: string[][] = [];
  const system: ActanaSystem & { calls: string[][] } = {
    calls,
    run(command, args) {
      calls.push([command, ...args]);
      // `tar` is the one command the update path really needs to work, so it
      // runs for real — extracting a fixture tarball built moments ago.
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
    async passthrough() {
      return 0;
    },
    async waitForPort() {
      return true;
    },
    async confirm() {
      return true;
    },
    signal() {
      return true;
    },
    ...overrides,
  };
  return system;
}

/** The state `actana setup` would have left behind for `INSTALLED_VERSION`. */
function existingInstall(version = INSTALLED_VERSION): ActanaConfig {
  const installDir = installDirFor(layout, version);
  writeTarballTree(installDir, {
    version,
    protocolVersion: "3",
    target: TARGET,
    platform: "linux",
    arch: "x64",
    nodeVersion: "24.15.0",
  });
  pointSymlink(layout.currentLink, installDir);
  pointSymlink(layout.binLink, path.join(layout.currentLink, "bin", "actana"));
  fs.mkdirSync(layout.dataDir, { recursive: true });

  const config: ActanaConfig = {
    version,
    port: 8443,
    host: "0.0.0.0",
    publicHost: "10.0.0.5",
    label: "vm-1",
    installDir,
    dataDir: layout.dataDir,
  };
  writeActanaConfig(layout.configDir, config);
  return config;
}

function update(
  over: Partial<Parameters<typeof runActanaUpdate>[0]> = {},
): ReturnType<typeof runActanaUpdate> {
  return runActanaUpdate({
    layout,
    // #288 D10: an update repoints the launcher only when the launcher is its
    // own, and it reads `PATH` to find out.
    env: { HOME: home, PATH: layout.binDir },
    config: readActanaConfig(layout.configDir)!,
    service: fakeService(),
    system: fakeSystem(),
    fetcher: fixtureFetcher(releaseDir, CHANNEL),
    channel: CHANNEL,
    platform: "linux",
    arch: "x64",
    out: (line) => out.push(line),
    ...over,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actana-update-"));
  home = path.join(tmp, "home");
  releaseDir = path.join(tmp, "releases");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  layout = resolveActanaLayout({ HOME: home }, home, "linux");
  out = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("landing a newer release", () => {
  beforeEach(() => {
    existingInstall();
    writeRelease({ dir: releaseDir, version: "0.2.0", target: TARGET });
  });

  it("installs it beside the old one and repoints `current` at it", async () => {
    const result = await update();

    expect(result.updated).toBe(true);
    expect(result.previousVersion).toBe(INSTALLED_VERSION);
    expect(result.version).toBe("0.2.0");
    expect(fs.realpathSync(layout.currentLink)).toBe(
      fs.realpathSync(installDirFor(layout, "0.2.0")),
    );
    // The old tree stays: `actana update --version 0.1.0` is the way back.
    expect(fs.existsSync(installDirFor(layout, INSTALLED_VERSION))).toBe(true);
    expect(readCoreManifest(installDirFor(layout, "0.2.0"))?.version).toBe("0.2.0");
  });

  it("records the new version so `status` and the next update agree with it", async () => {
    await update();
    const config = readActanaConfig(layout.configDir)!;
    expect(config.version).toBe("0.2.0");
    expect(config.installDir).toBe(installDirFor(layout, "0.2.0"));
    // Everything the operator chose at setup survives the update.
    expect(config.port).toBe(8443);
    expect(config.publicHost).toBe("10.0.0.5");
    expect(config.label).toBe("vm-1");
  });

  it("restarts the daemon onto the new tree and waits for its port", async () => {
    const service = fakeService();
    const result = await update({ service });
    expect(service.verbs).toEqual(["restart"]);
    expect(result.listening).toBe(true);
  });

  it("removes a pre-rename service before restarting onto the new tree (#348)", async () => {
    // The upgrade path in the report: `install.sh` places a new tree and the
    // operator runs `actana update`, never `actana setup`. The old agent runs
    // `current/bin/actana` too, so without this it comes back on the new
    // binary with the old environment and fights for the port.
    const order: string[] = [];
    const service = fakeService({
      removeLegacyUnit: () => {
        order.push("removeLegacyUnit");
        return "com.actana.harness";
      },
      verb: (verb) => {
        order.push(verb);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await update({ service });

    expect(order).toEqual(["removeLegacyUnit", "restart"]);
    expect(out.join("\n")).toMatch(/Removed com\.actana\.harness/);
  });

  it("keeps the legacy service when it is the only one, and never restarts into nothing", async () => {
    // The #348 machine: `actana setup` was never run after the rename, so
    // `com.actana.core` does not exist and the pre-rename agent is the only
    // auto-start service there is. Removing it and then failing to restart —
    // which is what this did — leaves the operator with no service at all.
    const removals: string[] = [];
    const service = fakeService({
      observe: () => ({ name: "com.actana.harness", legacyName: "com.actana.harness" }),
      removeLegacyUnit: () => {
        removals.push("removed");
        return "com.actana.harness";
      },
    });

    const result = await update({ service });

    expect(result.updated).toBe(true);
    expect(removals).toEqual([]);
    expect(service.verbs).toEqual([]);
    // Null rather than false: nothing was asked to start, so the port was
    // never a question.
    expect(result.listening).toBeNull();
    expect(out.join("\n")).toMatch(/com\.actana\.harness/);
    expect(out.join("\n")).toMatch(/actana setup/);
  });

  it("says so, without restarting, when there is no service at all", async () => {
    const service = fakeService({ observe: () => ({ name: null, legacyName: null }) });

    const result = await update({ service });

    expect(result.updated).toBe(true);
    expect(service.verbs).toEqual([]);
    expect(result.listening).toBeNull();
    expect(out.join("\n")).toMatch(/no auto-start service/);
    expect(out.join("\n")).toMatch(/actana setup/);
  });

  it("says nothing about a legacy service on a machine that has none", async () => {
    await update();
    expect(out.join("\n")).not.toMatch(/before the rename/);
  });

  it("says so when the daemon did not come back", async () => {
    const result = await update({ system: fakeSystem({ waitForPort: async () => false }) });
    expect(result.updated).toBe(true);
    expect(result.listening).toBe(false);
  });

  it("surfaces a failed restart with the init system's own message", async () => {
    const service = fakeService({
      verb: () => ({ status: 1, stdout: "", stderr: "Job failed" }),
    });
    await expect(update({ service })).rejects.toThrow(/Job failed/);
  });

  it("leaves nothing of the download behind", async () => {
    // Scoped to *this* invocation, by diffing the temp root either side of it,
    // rather than asserting the whole of `os.tmpdir()` is free of
    // `actana-update-work-` directories. The property under test is
    // per-invocation — `runActanaUpdate` removes its own work dir in a
    // `finally` — and the global spelling was reading somebody else's
    // in-flight state: `actana-machine-cli.test.ts` drives `actana update`
    // from another file in this same package, and once both suites moved here
    // from `packages/core` the two overlapped and this went red on a
    // property nothing had broken.
    const workDirs = () =>
      fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("actana-update-work-"));

    const before = new Set(workDirs());
    await update();
    expect(workDirs().filter((name) => !before.has(name))).toEqual([]);
  });
});

describe("a download that does not match its checksum", () => {
  beforeEach(() => {
    existingInstall();
    writeRelease({ dir: releaseDir, version: "0.2.0", target: TARGET });
  });

  it("aborts, saying what was expected and what arrived", async () => {
    const fetcher = fixtureFetcher(releaseDir, CHANNEL, {
      corrupt: [releaseAssetName("0.2.0", TARGET)],
    });
    await expect(update({ fetcher })).rejects.toThrow(/checksum/i);
  });

  it("leaves the running install completely untouched", async () => {
    const fetcher = fixtureFetcher(releaseDir, CHANNEL, {
      corrupt: [releaseAssetName("0.2.0", TARGET)],
    });
    const service = fakeService();
    await expect(update({ fetcher, service })).rejects.toThrow();

    expect(fs.realpathSync(layout.currentLink)).toBe(
      fs.realpathSync(installDirFor(layout, INSTALLED_VERSION)),
    );
    expect(fs.existsSync(installDirFor(layout, "0.2.0"))).toBe(false);
    expect(readActanaConfig(layout.configDir)!.version).toBe(INSTALLED_VERSION);
    // Nothing was stopped or restarted — the daemon never noticed.
    expect(service.verbs).toEqual([]);
    expect(service.stops).toBe(0);
  });
});

describe("choosing a version", () => {
  beforeEach(() => {
    existingInstall();
    writeRelease({ dir: releaseDir, version: "0.2.0", target: TARGET });
    writeRelease({ dir: releaseDir, version: "0.3.0", target: TARGET });
  });

  it("takes the latest release when none is pinned", async () => {
    expect((await update()).version).toBe("0.3.0");
  });

  it("installs exactly the pinned version, without asking what is latest", async () => {
    const fetcher = fixtureFetcher(releaseDir, CHANNEL);
    const result = await update({ fetcher, requestedVersion: "0.2.0" });

    expect(result.version).toBe("0.2.0");
    expect(fetcher.asked.some((url) => url.endsWith("/releases/latest"))).toBe(false);
  });

  it("accepts a pinned version spelled with a leading v", async () => {
    expect((await update({ requestedVersion: "v0.2.0" })).version).toBe("0.2.0");
  });

  it("downgrades on request — that is what recovering a version lock is", async () => {
    await update({ requestedVersion: "0.3.0" });
    const result = await update({
      config: readActanaConfig(layout.configDir)!,
      requestedVersion: "0.2.0",
    });
    expect(result.version).toBe("0.2.0");
    expect(readActanaConfig(layout.configDir)!.version).toBe("0.2.0");
  });

  it("does nothing when the installed version is already the one asked for", async () => {
    const fetcher = fixtureFetcher(releaseDir, CHANNEL);
    const service = fakeService();
    const result = await update({ fetcher, service, requestedVersion: INSTALLED_VERSION });

    expect(result.updated).toBe(false);
    expect(result.version).toBe(INSTALLED_VERSION);
    expect(service.verbs).toEqual([]);
    expect(fetcher.asked.some((url) => url.endsWith(".tar.gz"))).toBe(false);
  });

  it("reinstalls the current version when its tree has gone missing", async () => {
    fs.rmSync(installDirFor(layout, INSTALLED_VERSION), { recursive: true, force: true });
    writeRelease({ dir: releaseDir, version: INSTALLED_VERSION, target: TARGET });

    const result = await update({ requestedVersion: INSTALLED_VERSION });
    expect(result.updated).toBe(true);
    expect(fs.existsSync(installDirFor(layout, INSTALLED_VERSION))).toBe(true);
  });
});

describe("releases this machine cannot use", () => {
  beforeEach(() => {
    existingInstall();
  });

  it("names the missing target when the release has no build for it", async () => {
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "mac-arm64" });
    await expect(update()).rejects.toThrow(/linux-x64/);
  });

  it("refuses on a platform the project publishes no Cores for", async () => {
    writeRelease({ dir: releaseDir, version: "0.2.0", target: TARGET });
    await expect(update({ platform: "win32", arch: "x64" })).rejects.toThrow(/win32/);
  });

  // An Intel Mac is the one refusal with a real answer behind it rather than
  // an absence, and it is the second of the two front doors: `install.sh`'s
  // `detect_target` refuses the same machine by name (covered end-to-end in
  // scripts/__tests__/install-sh.test.mjs), and the two have to agree. Both
  // properties matter — the Docker path has to be *named*, or the operator
  // reads "no build" as a broken release; and it has to happen at detection,
  // or they wait through a download to be told.
  it("refuses an Intel Mac by name, and points at the container image", async () => {
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "mac-arm64" });
    const fetcher = fixtureFetcher(releaseDir, CHANNEL);

    await expect(update({ platform: "darwin", arch: "x64", fetcher })).rejects.toThrow(
      /Intel Mac.*Apple silicon.*container image/s,
    );
    // Detection, not a failed download: nothing was asked of the release host.
    expect(fetcher.asked).toEqual([]);
  });

  it("still installs on an Apple-silicon Mac, which is the target that exists", async () => {
    writeRelease({ dir: releaseDir, version: "0.2.0", target: "mac-arm64" });
    const result = await update({
      platform: "darwin",
      arch: "arm64",
      system: fakeSystem(),
    });
    expect(result.version).toBe("0.2.0");
  });

  it("rejects a tarball whose manifest is not the release it was served as", async () => {
    writeRelease({
      dir: releaseDir,
      version: "0.2.0",
      target: TARGET,
      manifest: { version: "9.9.9" },
    });
    await expect(update()).rejects.toThrow(/9\.9\.9/);
  });

  it("rejects a tarball that is not a complete Core build", async () => {
    writeRelease({
      dir: releaseDir,
      version: "0.2.0",
      target: TARGET,
      omit: [path.join("node", "bin", "node")],
    });
    await expect(update()).rejects.toThrow(/node/);
    expect(fs.existsSync(installDirFor(layout, "0.2.0"))).toBe(false);
  });

  it("explains a release channel it cannot reach", async () => {
    await expect(update()).rejects.toThrow(/releases\/latest|no release/i);
  });
});

// #322. `/releases/latest` cannot see a prerelease, so on a machine installed
// from a beta a bare `actana update` resolves the *previous* release. Before
// the guard, "0.4.0" !== "0.4.1-beta" waved straight past the already-current
// check and the machine was stopped, swapped and restarted onto an older
// version — and told it had been updated.
describe("a machine running a beta", () => {
  const BETA = "0.4.1-beta";

  beforeEach(() => {
    existingInstall(BETA);
  });

  describe("when the newest release is older than the beta", () => {
    beforeEach(() => {
      writeRelease({ dir: releaseDir, version: "0.4.0", target: TARGET });
    });

    it("does not replace the tree", async () => {
      const service = fakeService();
      const result = await update({ service });

      expect(result.updated).toBe(false);
      expect(result.version).toBe(BETA);
      expect(fs.realpathSync(layout.currentLink)).toBe(
        fs.realpathSync(installDirFor(layout, BETA)),
      );
      expect(fs.existsSync(installDirFor(layout, "0.4.0"))).toBe(false);
      expect(readActanaConfig(layout.configDir)!.version).toBe(BETA);
      // The daemon never noticed: no stop, no restart.
      expect(service.verbs).toEqual([]);
      expect(service.stops).toBe(0);
    });

    it("says what it is on, what the release is, and what to do about it", async () => {
      await update();
      const said = out.join("\n");
      expect(said).toContain(BETA);
      expect(said).toContain("prerelease");
      // The line, in ADR 0036 D1's vocabulary — the release this machine is
      // actually waiting for is its own line's.
      expect(said).toContain("0.4.1 line");
      expect(said).toContain("0.4.0");
      expect(said).toContain("actana update --version 0.4.0");
    });

    it("downloads nothing — the refusal is a decision, not a failed attempt", async () => {
      const fetcher = fixtureFetcher(releaseDir, CHANNEL);
      await update({ fetcher });
      expect(fetcher.asked.some((url) => url.endsWith(".tar.gz"))).toBe(false);
      expect(fetcher.asked.some((url) => url.endsWith("SHA256SUMS"))).toBe(false);
    });

    // An explicit pin is an operator's decision and is not second-guessed:
    // this is how a Panel↔Core version lock is recovered.
    it("still installs an older release when the operator pins it", async () => {
      const result = await update({ requestedVersion: "0.4.0" });

      expect(result.updated).toBe(true);
      expect(result.version).toBe("0.4.0");
      expect(result.previousVersion).toBe(BETA);
      expect(fs.realpathSync(layout.currentLink)).toBe(
        fs.realpathSync(installDirFor(layout, "0.4.0")),
      );
      expect(readActanaConfig(layout.configDir)!.version).toBe("0.4.0");
    });
  });

  // The other direction, and the reason the guard is a comparison rather than
  // "never move off a prerelease": the beta's own line releasing is exactly
  // what this machine is waiting for, and it must not be stranded.
  it("takes its own line's release the day it exists", async () => {
    writeRelease({ dir: releaseDir, version: "0.4.0", target: TARGET });
    writeRelease({ dir: releaseDir, version: "0.4.1", target: TARGET });

    const result = await update();
    expect(result.updated).toBe(true);
    expect(result.previousVersion).toBe(BETA);
    expect(result.version).toBe("0.4.1");
    expect(readActanaConfig(layout.configDir)!.version).toBe("0.4.1");
  });

  it("takes a later line's release too", async () => {
    writeRelease({ dir: releaseDir, version: "0.4.2", target: TARGET });
    expect((await update()).version).toBe("0.4.2");
  });
});

// The guard is about ordering, not about prereleases: a `latest` that has been
// moved backwards would walk a release-running machine back just as silently.
describe("a bare update that would move any machine backwards", () => {
  beforeEach(() => {
    existingInstall("0.5.0");
    writeRelease({ dir: releaseDir, version: "0.4.0", target: TARGET });
  });

  it("refuses, and does not call the installed version a prerelease", async () => {
    const result = await update();
    expect(result.updated).toBe(false);
    expect(result.version).toBe("0.5.0");
    const said = out.join("\n");
    expect(said).toContain("0.5.0");
    expect(said).toContain("0.4.0");
    expect(said).not.toContain("prerelease");
    expect(said).toContain("actana update --version 0.4.0");
  });
});
