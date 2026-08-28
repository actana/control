import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveActanaLayout, type ActanaLayout } from "../actana-layout";
import { createServiceManager, supportsService } from "../actana-service";
import type { ActanaSystem, CommandResult } from "../actana-system";

/** A recording ActanaSystem where every command succeeds unless told otherwise. */
function fakeSystem(overrides: Record<string, CommandResult> = {}) {
  const calls: string[][] = [];
  const system: ActanaSystem & { calls: string[][] } = {
    calls,
    run(command, args) {
      calls.push([command, ...args]);
      const key = [command, ...args].join(" ");
      for (const [prefix, result] of Object.entries(overrides)) {
        if (key.startsWith(prefix)) return result;
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    async passthrough(command, args) {
      calls.push([command, ...args]);
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
  };
  return system;
}

const DEFINITION = {
  description: "Actana Control Core",
  argv: ["/opt/actana/current/bin/actana", "daemon"],
  workingDirectory: "/home/op",
  environment: { AC_CORE_REMOTE: "1" },
};

/** The pre-rename LaunchAgent label — what a machine upgraded in place keeps. */
const LEGACY_LABEL = "com.actana.harness";

/** `launchctl print` answers for a job launchd has, and for one it does not. */
const OK: CommandResult = { status: 0, stdout: "", stderr: "" };
const MISSING: CommandResult = { status: 113, stdout: "", stderr: "Could not find service" };

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actana-service-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managerFor(platform: NodeJS.Platform, system: ActanaSystem) {
  const layout: ActanaLayout = resolveActanaLayout({}, home, platform);
  return { manager: createServiceManager({ platform, layout, system, user: "op", uid: 501 }), layout };
}

describe("createServiceManager", () => {
  it("gives Linux systemd and macOS launchd", () => {
    expect(managerFor("linux", fakeSystem()).manager.kind).toBe("systemd");
    expect(managerFor("darwin", fakeSystem()).manager.kind).toBe("launchd");
  });

  it("refuses a platform with neither, naming both it does support", () => {
    const layout = resolveActanaLayout({}, home, "win32");
    expect(() =>
      createServiceManager({
        platform: "win32",
        layout,
        system: fakeSystem(),
        user: "op",
        uid: 501,
      }),
    ).toThrow(/win32/);
    expect(supportsService("win32")).toBe(false);
    expect(supportsService("linux")).toBe(true);
    expect(supportsService("darwin")).toBe(true);
  });
});

describe("systemd manager — state", () => {
  const show = (stdout: string) => ({
    "systemctl --user show": { status: 0, stdout, stderr: "" },
  });

  it("reads a running unit", () => {
    const { manager } = managerFor(
      "linux",
      fakeSystem(
        show("LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4211"),
      ),
    );
    expect(manager.state()).toEqual({
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      mainPid: 4211,
    });
  });

  it("reports no service at all for a unit systemd has never heard of", () => {
    const { manager } = managerFor(
      "linux",
      fakeSystem(show("LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0")),
    );
    expect(manager.state()).toBeNull();
  });

  it("reports no service when systemctl itself cannot be run", () => {
    const { manager } = managerFor(
      "linux",
      fakeSystem({ "systemctl --user show": { status: 127, stdout: "", stderr: "not found" } }),
    );
    expect(manager.state()).toBeNull();
  });

  it("tails the journal for the unit, never a file", () => {
    const { manager } = managerFor("linux", fakeSystem());
    expect(manager.logs({ follow: true, lines: 50 })).toEqual({
      command: "journalctl",
      args: ["--user", "-u", "actana-core.service", "--no-pager", "--lines", "50", "--follow"],
    });
  });
});

describe("uninstalling the service", () => {
  it("stops, disables, and removes the systemd unit, then reloads", () => {
    const system = fakeSystem();
    const { manager, layout } = managerFor("linux", system);
    manager.install(DEFINITION);
    expect(fs.existsSync(layout.servicePath)).toBe(true);

    manager.uninstall();

    const commands = system.calls.map((c) => c.join(" "));
    expect(commands).toContain("systemctl --user stop actana-core.service");
    expect(commands).toContain("systemctl --user disable actana-core.service");
    expect(fs.existsSync(layout.servicePath)).toBe(false);
    // The reload must come after the file is gone, or systemd keeps the unit.
    const reload = commands.lastIndexOf("systemctl --user daemon-reload");
    expect(reload).toBeGreaterThan(commands.indexOf("systemctl --user disable actana-core.service"));
  });

  it("boots the LaunchAgent out and removes its plist", () => {
    const system = fakeSystem();
    const { manager, layout } = managerFor("darwin", system);
    manager.install(DEFINITION);

    manager.uninstall();

    expect(system.calls.map((c) => c.join(" "))).toContain(
      "launchctl bootout gui/501/com.actana.core",
    );
    expect(fs.existsSync(layout.servicePath)).toBe(false);
  });

  it("never leaves the label disabled — a reinstall must be able to bootstrap", () => {
    const system = fakeSystem();
    const { manager } = managerFor("darwin", system);
    manager.install(DEFINITION);
    manager.uninstall();
    // `launchctl disable` writes a persistent override that survives the plist
    // being deleted, and blocks every later bootstrap of the same label.
    expect(system.calls.some((c) => c[1] === "disable")).toBe(false);
  });

  it.each(["linux", "darwin"] as const)(
    "succeeds on %s when there is nothing installed to remove",
    (platform) => {
      const { manager } = managerFor(
        platform,
        fakeSystem({
          systemctl: { status: 5, stdout: "", stderr: "Unit not loaded." },
          launchctl: { status: 113, stdout: "", stderr: "Could not find service" },
        }),
      );
      expect(() => manager.uninstall()).not.toThrow();
    },
  );
});

describe("removing the pre-rename unit", () => {
  /** The unit `actana setup` wrote when the machine was called a Harness. */
  const LEGACY_UNIT = "actana-harness.service";

  /** The pre-rename plist an in-place upgrade leaves in `~/Library/LaunchAgents`. */
  function plantLegacyAgent(layout: ActanaLayout): string {
    fs.mkdirSync(layout.serviceDir, { recursive: true });
    const legacyPath = path.join(layout.serviceDir, `${LEGACY_LABEL}.plist`);
    fs.writeFileSync(legacyPath, "<plist/>\n");
    return legacyPath;
  }

  function plantLegacyUnit(layout: ActanaLayout): string {
    fs.mkdirSync(layout.serviceDir, { recursive: true });
    const legacyPath = path.join(layout.serviceDir, LEGACY_UNIT);
    fs.writeFileSync(legacyPath, "[Unit]\nDescription=Actana Control Harness\n");
    return legacyPath;
  }

  it("stops it, disables it, removes it, and names what it removed", () => {
    const system = fakeSystem();
    const { manager, layout } = managerFor("linux", system);
    const legacyPath = plantLegacyUnit(layout);

    expect(manager.removeLegacyUnit()).toBe(LEGACY_UNIT);

    const commands = system.calls.map((c) => c.join(" "));
    expect(commands).toContain(`systemctl --user stop ${LEGACY_UNIT}`);
    expect(commands).toContain(`systemctl --user disable ${LEGACY_UNIT}`);
    expect(fs.existsSync(legacyPath)).toBe(false);
    // Same ordering rule as uninstall: the reload only sticks once the file is
    // gone, or systemd keeps the unit it just re-read.
    expect(commands.lastIndexOf("systemctl --user daemon-reload")).toBeGreaterThan(
      commands.indexOf(`systemctl --user disable ${LEGACY_UNIT}`),
    );
  });

  it("disables it even when only the enablement link is left", () => {
    const system = fakeSystem();
    const { manager, layout } = managerFor("linux", system);
    const legacyPath = plantLegacyUnit(layout);
    // What a hand-deleted unit file leaves: a dangling symlink that still
    // starts the old daemon at boot, and a running daemon systemd has not
    // been told to forget.
    const wants = path.join(layout.serviceDir, "default.target.wants");
    fs.mkdirSync(wants, { recursive: true });
    fs.symlinkSync(legacyPath, path.join(wants, LEGACY_UNIT));
    fs.rmSync(legacyPath);

    expect(manager.removeLegacyUnit()).toBe(LEGACY_UNIT);
    expect(system.calls.map((c) => c.join(" "))).toContain(
      `systemctl --user disable ${LEGACY_UNIT}`,
    );
  });

  it("runs nothing on a machine that never had one, however often it is called", () => {
    const system = fakeSystem();
    const { manager } = managerFor("linux", system);

    expect(manager.removeLegacyUnit()).toBeNull();
    expect(manager.removeLegacyUnit()).toBeNull();
    expect(system.calls).toEqual([]);
  });

  it("never touches the unit setup just installed", () => {
    const system = fakeSystem();
    const { manager, layout } = managerFor("linux", system);
    manager.install(DEFINITION);

    expect(manager.removeLegacyUnit()).toBeNull();
    expect(fs.existsSync(layout.servicePath)).toBe(true);
  });

  it("boots out the pre-rename LaunchAgent, deletes its plist, and names it", () => {
    const system = fakeSystem();
    const { manager, layout } = managerFor("darwin", system);
    const legacyPath = plantLegacyAgent(layout);

    expect(manager.removeLegacyUnit()).toBe(LEGACY_LABEL);

    expect(system.calls.map((c) => c.join(" "))).toContain(
      `launchctl bootout gui/501/${LEGACY_LABEL}`,
    );
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("boots out a loaded legacy job whose plist someone already deleted", () => {
    // `rm`ing the plist unloads nothing: launchd holds the copy it read at
    // bootstrap time, so the old daemon is still up and still holds the port.
    const system = fakeSystem({ [`launchctl print gui/501/${LEGACY_LABEL}`]: OK });
    const { manager } = managerFor("darwin", system);

    expect(manager.removeLegacyUnit()).toBe(LEGACY_LABEL);
    expect(system.calls.map((c) => c.join(" "))).toContain(
      `launchctl bootout gui/501/${LEGACY_LABEL}`,
    );
  });

  it("removes nothing on a macOS machine that never had one", () => {
    const system = fakeSystem({ "launchctl print": MISSING });
    const { manager } = managerFor("darwin", system);

    expect(manager.removeLegacyUnit()).toBeNull();
    expect(manager.removeLegacyUnit()).toBeNull();
    expect(system.calls.map((c) => c.join(" "))).not.toContain(
      `launchctl bootout gui/501/${LEGACY_LABEL}`,
    );
  });

  it("leaves the agent setup just installed alone", () => {
    const system = fakeSystem({ "launchctl print": MISSING });
    const { manager, layout } = managerFor("darwin", system);
    manager.install(DEFINITION);

    expect(manager.removeLegacyUnit()).toBeNull();
    expect(fs.existsSync(layout.servicePath)).toBe(true);
  });
});

describe("launchd manager — state", () => {
  /** An installed agent: `state()` reads the plist off disk before launchctl. */
  function installed(system: ActanaSystem) {
    const { manager, layout } = managerFor("darwin", system);
    manager.install(DEFINITION);
    return { manager, layout };
  }

  it("reports nothing installed before setup has written a plist", () => {
    // No plist under either label, and launchd has never heard of either job.
    const { manager } = managerFor("darwin", fakeSystem({ "launchctl print gui/501/": MISSING }));
    expect(manager.state()).toBeNull();
  });

  it("reports the legacy agent's state rather than `not installed` (#348)", () => {
    // The machine in the report: a pre-rename agent launchd is really running,
    // no plist under the current label, and a `State  not installed` that was
    // flatly untrue while a Core was up and holding the port.
    const system = fakeSystem({
      "launchctl print gui/501/com.actana.core": MISSING,
      "launchctl print gui/501/com.actana.harness": {
        status: 0,
        stdout: "\tstate = running\n\tpid = 991\n",
        stderr: "",
      },
    });
    const { manager } = managerFor("darwin", system);

    expect(manager.state()).toEqual({
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      mainPid: 991,
    });
  });

  it("reads a running agent's pid", () => {
    const { manager } = installed(
      fakeSystem({
        "launchctl print gui/501/com.actana.core": {
          status: 0,
          stdout: "\tstate = running\n\tpid = 4211\n",
          stderr: "",
        },
      }),
    );
    expect(manager.state()).toEqual({
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      mainPid: 4211,
    });
  });

  it("reads an installed-but-unloaded agent as stopped, not missing", () => {
    const { manager } = installed(
      fakeSystem({
        "launchctl print gui/501/com.actana.core": {
          status: 113,
          stdout: "",
          stderr: "Could not find service",
        },
      }),
    );
    // The domain itself answers; only the job lookup fails.
    expect(manager.state()).toEqual({
      loadState: "loaded",
      activeState: "inactive",
      subState: "dead",
      mainPid: null,
    });
  });

  it("reads a loaded-but-not-running agent as activating — something to fix", () => {
    const { manager } = installed(
      fakeSystem({
        "launchctl print gui/501/com.actana.core": {
          status: 0,
          stdout: "\tstate = waiting\n",
          stderr: "",
        },
      }),
    );
    expect(manager.state()).toMatchObject({ activeState: "activating", subState: "waiting" });
  });

  it("writes the plist where launchd reads user agents", () => {
    const { manager, layout } = installed(fakeSystem());
    expect(layout.servicePath).toBe(
      path.join(home, "Library", "LaunchAgents", "com.actana.core.plist"),
    );
    expect(fs.readFileSync(manager.filePath, "utf8")).toContain("<key>Label</key>");
  });

  it("names the label launchd actually loaded, not the one setup would write", () => {
    const system = fakeSystem({
      "launchctl print gui/501/com.actana.core": MISSING,
      "launchctl print gui/501/com.actana.harness": OK,
    });
    const { manager } = managerFor("darwin", system);

    expect(manager.name).toBe("com.actana.core");
    expect(manager.observe()).toEqual({ name: LEGACY_LABEL, legacyName: LEGACY_LABEL });
  });

  it("reports both when an in-place upgrade left the old agent beside the new one", () => {
    const system = fakeSystem({ "launchctl print gui/501/": MISSING });
    const { manager, layout } = installed(system);
    fs.writeFileSync(path.join(layout.serviceDir, `${LEGACY_LABEL}.plist`), "<plist/>\n");

    expect(manager.observe()).toEqual({ name: "com.actana.core", legacyName: LEGACY_LABEL });
  });

  it("reports no service at all on a machine with neither plist", () => {
    const { manager } = managerFor("darwin", fakeSystem({ "launchctl print gui/501/": MISSING }));
    expect(manager.observe()).toEqual({ name: null, legacyName: null });
  });

  it("probes the domain once however many verbs are run", () => {
    const system = fakeSystem();
    const { manager } = installed(system);
    manager.isActive();
    manager.state();
    manager.verb("restart");
    expect(system.calls.filter((c) => c.join(" ") === "launchctl print gui/501")).toHaveLength(1);
  });
});
