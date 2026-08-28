import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { actanaConfigPath, writeActanaConfig } from "../actana-config";
import { installDirFor, resolveActanaLayout, type ActanaLayout } from "../actana-layout";
import type { ActanaServiceManager } from "../actana-service";
import { materialFilePath } from "@actana/shared/core-material-store";
import { pointSymlink } from "../actana-tree";
import { runActanaUninstall } from "../actana-uninstall";
import { writeTarballTree } from "./release-fixture";

let tmp: string;
let home: string;
let layout: ActanaLayout;
let out: string[];

/** A service manager that records the one call an uninstall makes of it. */
function fakeService() {
  const service = {
    uninstalls: 0,
    kind: "systemd" as const,
    name: "actana-core.service",
    filePath: path.join(home, ".config", "systemd", "user", "actana-core.service"),
    isActive: () => true,
    stop() {},
    install() {},
    uninstall() {
      service.uninstalls += 1;
      fs.rmSync(service.filePath, { force: true });
    },
    // Typed rather than inferred as `() => null`, so a test can stand this up
    // as the machine that *does* carry a pre-rename service.
    removeLegacyUnit: (): string | null => null,
    observe: () => ({ name: "actana-core.service", legacyName: null }),
    async ensurePersistence() {
      return { survivesLogout: true, summary: "enabled, lingering" };
    },
    enableAndStart() {},
    state: () => null,
    verb: () => ({ status: 0, stdout: "", stderr: "" }),
    persistence: () => null,
    logs: () => ({ command: "journalctl", args: [] }),
  };
  return service satisfies ActanaServiceManager & { uninstalls: number };
}

/** Everything `actana setup` leaves on a machine. */
function installedMachine(): void {
  const installDir = installDirFor(layout, "0.1.0");
  writeTarballTree(installDir, {
    version: "0.1.0",
    protocolVersion: "3",
    target: "linux-x64",
    platform: "linux",
    arch: "x64",
    nodeVersion: "24.15.0",
  });
  pointSymlink(layout.currentLink, installDir);
  pointSymlink(layout.binLink, path.join(layout.currentLink, "bin", "actana"));

  fs.mkdirSync(layout.dataDir, { recursive: true });
  fs.writeFileSync(path.join(layout.dataDir, "core.db"), "sessions and events");

  fs.mkdirSync(layout.configDir, { recursive: true });
  fs.writeFileSync(materialFilePath(layout.configDir), '{"coreId":"core_1"}');
  writeActanaConfig(layout.configDir, {
    version: "0.1.0",
    port: 8443,
    host: "0.0.0.0",
    publicHost: "10.0.0.5",
    label: "vm-1",
    installDir,
    dataDir: layout.dataDir,
  });

  fs.mkdirSync(path.dirname(fakeService().filePath), { recursive: true });
  fs.writeFileSync(fakeService().filePath, "[Unit]\n");
}

function uninstall(purgeData = false, service = fakeService()) {
  return runActanaUninstall({ layout, service, purgeData, out: (line) => out.push(line) });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actana-uninstall-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  layout = resolveActanaLayout({ HOME: home }, home, "linux");
  out = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("uninstall", () => {
  beforeEach(installedMachine);

  it("leaves no unit, no launcher, and no install files", () => {
    const service = fakeService();
    uninstall(false, service);

    expect(service.uninstalls).toBe(1);
    expect(fs.existsSync(service.filePath)).toBe(false);
    expect(fs.existsSync(layout.binLink)).toBe(false);
    expect(fs.existsSync(layout.versionsDir)).toBe(false);
    expect(fs.existsSync(layout.currentLink)).toBe(false);
  });

  it("keeps the data dir by default — a reinstall finds its sessions again", () => {
    uninstall();
    expect(fs.readFileSync(path.join(layout.dataDir, "core.db"), "utf8")).toBe(
      "sessions and events",
    );
  });

  it("keeps the pairing material by default, and says the Core stays paired", () => {
    uninstall();
    expect(fs.existsSync(materialFilePath(layout.configDir))).toBe(true);
    expect(fs.existsSync(actanaConfigPath(layout.configDir))).toBe(true);
    expect(out.join("\n")).toMatch(/--purge-data/);
  });

  it("removes the data dir and the credentials with --purge-data", () => {
    uninstall(true);
    expect(fs.existsSync(layout.dataDir)).toBe(false);
    expect(fs.existsSync(layout.configDir)).toBe(false);
    expect(fs.existsSync(layout.root)).toBe(false);
  });

  it("reports what it removed and what it kept", () => {
    const result = uninstall();
    expect(result.removed).toContain(layout.versionsDir);
    expect(result.removed).toContain(layout.binLink);
    expect(result.kept).toContain(layout.dataDir);
  });

  it("names only the halves that were actually there when a unit was not", () => {
    // An install with no unit file: the summary may claim the install and must
    // not claim a service.
    installedMachine();
    fs.rmSync(fakeService().filePath, { force: true });

    runActanaUninstall({
      layout,
      service: fakeService(),
      purgeData: false,
      out: (line) => out.push(line),
    });

    expect(out.join("\n")).toContain("Removed the Core install.");
    expect(out.join("\n")).not.toContain("actana-core.service service");
  });

  it("keeps the root only for the data it holds, not as an empty shell", () => {
    // The default data dir lives inside the install root, so the root survives
    // a plain uninstall — but with nothing in it except that data.
    uninstall();
    expect(fs.readdirSync(layout.root)).toEqual(["data"]);
  });

  it("removes the root when the data dir lives somewhere else", () => {
    // `ACTANA_DATA_DIR` outside the install root: nothing worth keeping is
    // under `~/.local/share/actana`, so the whole root goes.
    const elsewhere = path.join(tmp, "data-elsewhere");
    fs.renameSync(layout.dataDir, elsewhere);
    layout = { ...layout, dataDir: elsewhere };

    uninstall();
    expect(fs.existsSync(layout.root)).toBe(false);
    expect(fs.existsSync(elsewhere)).toBe(true);
  });

  it("leaves the rest of ~/.local/bin alone", () => {
    const neighbour = path.join(layout.binDir, "some-other-tool");
    fs.writeFileSync(neighbour, "#!/bin/sh\n");

    uninstall();
    expect(fs.existsSync(neighbour)).toBe(true);
    expect(fs.existsSync(layout.binDir)).toBe(true);
  });

  it("does not delete an `actana` on PATH that is not the one it installed", () => {
    // Someone's own build, or a second install: removing it would be this
    // command reaching outside what it put there.
    fs.rmSync(layout.binLink, { force: true });
    fs.writeFileSync(layout.binLink, "#!/bin/sh\n# a hand-rolled actana\n");

    const result = uninstall();
    expect(fs.existsSync(layout.binLink)).toBe(true);
    expect(result.kept).toContain(layout.binLink);
  });
});

describe("uninstalling a machine that is already mostly clean", () => {
  // ─── a machine carrying only the pre-rename agent (#353 review C4) ──────
  //
  // `actana uninstall` deliberately runs without requiring an install, so this
  // machine is reachable: the #348 cleanup path, on exactly the machine #348 is
  // about. The legacy removal must not be mistaken for an install having been
  // here — `removed` is both a list of paths and the caller's "did this run do
  // anything?" signal.
  it("does not claim a service or an install that were never here", () => {
    const service = fakeService();
    service.removeLegacyUnit = () => "com.actana.harness";

    const result = uninstall(false, service);

    // Nothing of an install was on this machine, so nothing is reported as
    // removed; the legacy agent has its own field.
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.removedLegacyService).toBe("com.actana.harness");
    const said = out.join("\n");
    expect(said).toContain("com.actana.harness");
    // The two false statements this used to print.
    expect(said).not.toContain("actana-core.service");
    expect(said).not.toMatch(/and the Core install/);
  });

  it("succeeds with nothing installed at all", () => {
    const service = fakeService();
    expect(() => uninstall(false, service)).not.toThrow();
    expect(service.uninstalls).toBe(1);
  });

  it("is safe to run twice", () => {
    installedMachine();
    uninstall(true);
    expect(() => uninstall(true)).not.toThrow();
    expect(fs.existsSync(layout.root)).toBe(false);
  });
});
