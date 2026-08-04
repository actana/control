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
const INSTALLED_VERSION = "0.49.0";

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
    writeRelease({ dir: releaseDir, version: "0.50.0", target: TARGET });
  });

  it("installs it beside the old one and repoints `current` at it", async () => {
    const result = await update();

    expect(result.updated).toBe(true);
    expect(result.previousVersion).toBe(INSTALLED_VERSION);
    expect(result.version).toBe("0.50.0");
    expect(fs.realpathSync(layout.currentLink)).toBe(
      fs.realpathSync(installDirFor(layout, "0.50.0")),
    );
    // The old tree stays: `actana update --version 0.49.0` is the way back.
    expect(fs.existsSync(installDirFor(layout, INSTALLED_VERSION))).toBe(true);
    expect(readCoreManifest(installDirFor(layout, "0.50.0"))?.version).toBe("0.50.0");
  });

  it("records the new version so `status` and the next update agree with it", async () => {
    await update();
    const config = readActanaConfig(layout.configDir)!;
    expect(config.version).toBe("0.50.0");
    expect(config.installDir).toBe(installDirFor(layout, "0.50.0"));
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
    await update();
    const strays = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("actana-update-work-"));
    expect(strays).toEqual([]);
  });
});

describe("a download that does not match its checksum", () => {
  beforeEach(() => {
    existingInstall();
    writeRelease({ dir: releaseDir, version: "0.50.0", target: TARGET });
  });

  it("aborts, saying what was expected and what arrived", async () => {
    const fetcher = fixtureFetcher(releaseDir, CHANNEL, {
      corrupt: [releaseAssetName("0.50.0", TARGET)],
    });
    await expect(update({ fetcher })).rejects.toThrow(/checksum/i);
  });

  it("leaves the running install completely untouched", async () => {
    const fetcher = fixtureFetcher(releaseDir, CHANNEL, {
      corrupt: [releaseAssetName("0.50.0", TARGET)],
    });
    const service = fakeService();
    await expect(update({ fetcher, service })).rejects.toThrow();

    expect(fs.realpathSync(layout.currentLink)).toBe(
      fs.realpathSync(installDirFor(layout, INSTALLED_VERSION)),
    );
    expect(fs.existsSync(installDirFor(layout, "0.50.0"))).toBe(false);
    expect(readActanaConfig(layout.configDir)!.version).toBe(INSTALLED_VERSION);
    // Nothing was stopped or restarted — the daemon never noticed.
    expect(service.verbs).toEqual([]);
    expect(service.stops).toBe(0);
  });
});

describe("choosing a version", () => {
  beforeEach(() => {
    existingInstall();
    writeRelease({ dir: releaseDir, version: "0.50.0", target: TARGET });
    writeRelease({ dir: releaseDir, version: "0.51.0", target: TARGET });
  });

  it("takes the latest release when none is pinned", async () => {
    expect((await update()).version).toBe("0.51.0");
  });

  it("installs exactly the pinned version, without asking what is latest", async () => {
    const fetcher = fixtureFetcher(releaseDir, CHANNEL);
    const result = await update({ fetcher, requestedVersion: "0.50.0" });

    expect(result.version).toBe("0.50.0");
    expect(fetcher.asked.some((url) => url.endsWith("/releases/latest"))).toBe(false);
  });

  it("accepts a pinned version spelled with a leading v", async () => {
    expect((await update({ requestedVersion: "v0.50.0" })).version).toBe("0.50.0");
  });

  it("downgrades on request — that is what recovering a version lock is", async () => {
    await update({ requestedVersion: "0.51.0" });
    const result = await update({
      config: readActanaConfig(layout.configDir)!,
      requestedVersion: "0.50.0",
    });
    expect(result.version).toBe("0.50.0");
    expect(readActanaConfig(layout.configDir)!.version).toBe("0.50.0");
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
    writeRelease({ dir: releaseDir, version: "0.50.0", target: "mac-arm64" });
    await expect(update()).rejects.toThrow(/linux-x64/);
  });

  it("refuses on a platform the project publishes no Cores for", async () => {
    writeRelease({ dir: releaseDir, version: "0.50.0", target: TARGET });
    await expect(update({ platform: "win32", arch: "x64" })).rejects.toThrow(/win32/);
  });

  it("rejects a tarball whose manifest is not the release it was served as", async () => {
    writeRelease({
      dir: releaseDir,
      version: "0.50.0",
      target: TARGET,
      manifest: { version: "9.9.9" },
    });
    await expect(update()).rejects.toThrow(/9\.9\.9/);
  });

  it("rejects a tarball that is not a complete Core build", async () => {
    writeRelease({
      dir: releaseDir,
      version: "0.50.0",
      target: TARGET,
      omit: [path.join("node", "bin", "node")],
    });
    await expect(update()).rejects.toThrow(/node/);
    expect(fs.existsSync(installDirFor(layout, "0.50.0"))).toBe(false);
  });

  it("explains a release channel it cannot reach", async () => {
    await expect(update()).rejects.toThrow(/releases\/latest|no release/i);
  });
});
