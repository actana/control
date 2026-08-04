import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeRegistrationBlob } from "@actana/shared/registration-blob";
import { verifyBearer } from "@actana/shared/core-link-bearer";
import { readActanaConfig } from "../actana-config";
import { resolveActanaLayout, type ActanaLayout } from "../actana-layout";
import { loadMaterial } from "../core-material-store";
import { createServiceManager } from "../actana-service";
import { runActanaSetup, choosePublicHost, type SetupOptions } from "../actana-setup";
import type { ActanaSystem, CommandResult } from "../actana-system";

const MANIFEST = {
  version: "0.49.0",
  protocolVersion: "3",
  target: "linux-x64",
  platform: "linux",
  arch: "x64",
  nodeVersion: "24.15.0",
};

/** A recording ActanaSystem where every command succeeds unless told otherwise. */
function fakeSystem(overrides: Partial<Record<string, CommandResult>> = {}) {
  const calls: string[][] = [];
  const confirms: string[] = [];
  const system: ActanaSystem & { calls: string[][]; confirms: string[]; answer: boolean } = {
    calls,
    confirms,
    answer: true,
    run(command, args) {
      calls.push([command, ...args]);
      const key = [command, ...args].join(" ");
      for (const [prefix, result] of Object.entries(overrides)) {
        if (key.startsWith(prefix) && result) return result;
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
    async confirm(question) {
      confirms.push(question);
      return system.answer;
    },
    signal() {
      return true;
    },
  };
  return system;
}

let tmp: string;
let home: string;
let sourceRoot: string;
let layout: ActanaLayout;

/** Write a directory tree that looks like an extracted Core tarball. */
function makeTarballTree(root: string, manifest = MANIFEST): void {
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "node", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "actana"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(root, "bin", "actana"), 0o755);
  fs.writeFileSync(path.join(root, "app", "core-entry.cjs"), "// daemon\n");
  fs.writeFileSync(path.join(root, "node", "bin", "node"), "#!/bin/sh\n");
  fs.chmodSync(path.join(root, "node", "bin", "node"), 0o755);
  fs.writeFileSync(
    path.join(root, "core-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

function options(system: ActanaSystem, over: Partial<SetupOptions> = {}): SetupOptions {
  const merged: Omit<SetupOptions, "service"> = {
    layout,
    sourceRoot,
    manifest: MANIFEST,
    port: 8443,
    host: "0.0.0.0",
    publicHost: "10.0.0.5",
    label: "vm-1",
    platform: "linux",
    arch: "x64",
    assumeYes: true,
    interactive: false,
    requestedHarnesses: [],
    // Every agent already present, so the default setup path has no offers to
    // make. The tests that care about offers override this.
    noHarnesses: false,
    probeHarnesses: () => ({
      "claude-code": { status: "available", path: "/usr/bin/claude" },
      codex: { status: "available", path: "/usr/bin/codex" },
      "cursor-cli": { status: "available", path: "/usr/bin/cursor-agent" },
      opencode: { status: "available", path: "/usr/bin/opencode" },
    }),
    system,
    out: () => {},
    ...over,
  };
  // The real service manager over the fake system: what these tests are about
  // is the sequence of commands setup drives, and a second fake of the init
  // system would only assert that the fake matches itself.
  return {
    ...merged,
    service:
      over.service ??
      createServiceManager({
        platform: merged.platform,
        layout: merged.layout,
        system,
        user: "op",
        uid: 501,
      }),
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actana-setup-"));
  home = path.join(tmp, "home");
  sourceRoot = path.join(tmp, "extract", "actana-core-0.49.0-linux-x64");
  fs.mkdirSync(home, { recursive: true });
  makeTarballTree(sourceRoot);
  layout = resolveActanaLayout({}, home, "linux");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runActanaSetup — the install layout", () => {
  it("installs the tree under the operator's home, versioned", async () => {
    const result = await runActanaSetup(options(fakeSystem()));

    expect(result.installDir).toBe(path.join(layout.versionsDir, "0.49.0"));
    expect(fs.existsSync(path.join(result.installDir, "app", "core-entry.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(result.installDir, "node", "bin", "node"))).toBe(true);
  });

  it("keeps the launcher and the bundled node executable", async () => {
    const result = await runActanaSetup(options(fakeSystem()));
    for (const rel of [["bin", "actana"], ["node", "bin", "node"]]) {
      const mode = fs.statSync(path.join(result.installDir, ...rel)).mode;
      expect(mode & 0o111).toBeGreaterThan(0);
    }
  });

  it("points `current` at the installed version", async () => {
    const result = await runActanaSetup(options(fakeSystem()));
    expect(fs.realpathSync(layout.currentLink)).toBe(fs.realpathSync(result.installDir));
  });

  it("links the launcher onto the operator's bin dir", async () => {
    await runActanaSetup(options(fakeSystem()));
    expect(fs.lstatSync(layout.binLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(layout.binLink)).toBe(path.join(layout.currentLink, "bin", "actana"));
  });

  it("writes no file outside the operator's home — nothing needs sudo", async () => {
    await runActanaSetup(options(fakeSystem()));
    for (const p of [layout.root, layout.configDir, layout.servicePath, layout.binLink]) {
      expect(p.startsWith(home)).toBe(true);
      expect(fs.existsSync(p)).toBe(true);
    }
  });

  it("creates the data dir the daemon writes SQLite into", async () => {
    await runActanaSetup(options(fakeSystem()));
    expect(fs.statSync(layout.dataDir).isDirectory()).toBe(true);
  });

  it("records what it decided in actana.json", async () => {
    await runActanaSetup(options(fakeSystem()));
    expect(readActanaConfig(layout.configDir)).toEqual({
      version: "0.49.0",
      port: 8443,
      host: "0.0.0.0",
      publicHost: "10.0.0.5",
      label: "vm-1",
      installDir: path.join(layout.versionsDir, "0.49.0"),
      dataDir: layout.dataDir,
    });
  });
});

describe("runActanaSetup — the pairing token", () => {
  it("returns a token that decodes into a usable Registration blob", async () => {
    const result = await runActanaSetup(options(fakeSystem()));

    const blob = decodeRegistrationBlob(result.blob);
    expect(blob).not.toBeNull();
    expect(blob?.endpoint).toBe("wss://10.0.0.5:8443");
    expect(blob?.label).toBe("vm-1");
    expect(blob?.caCert).toContain("BEGIN CERTIFICATE");
    expect(blob?.clientKey).toContain("PRIVATE KEY");
  });

  it("signs the bearer with the secret the daemon will load from disk", async () => {
    const result = await runActanaSetup(options(fakeSystem()));

    const blob = decodeRegistrationBlob(result.blob);
    const material = loadMaterial(layout.configDir);
    expect(material).not.toBeNull();
    const verified = verifyBearer(blob!.bearer, material!.bearerSecret);
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.coreId).toBe(material!.coreId);
  });

  it("persists material chmod 0600 — it holds private keys", async () => {
    await runActanaSetup(options(fakeSystem()));
    const mode = fs.statSync(path.join(layout.configDir, "material.json")).mode;
    expect(mode & 0o777).toBe(0o600);
  });
});

describe("runActanaSetup — the systemd unit", () => {
  it("writes a user unit that starts the daemon through the current symlink", async () => {
    await runActanaSetup(options(fakeSystem()));

    const unit = fs.readFileSync(layout.servicePath, "utf8");
    expect(unit).toContain(`ExecStart="${path.join(layout.currentLink, "bin", "actana")}" "daemon"`);
    expect(unit).toContain("WantedBy=default.target");
  });

  it("gives the daemon the env it needs to resume the same identity", async () => {
    await runActanaSetup(options(fakeSystem()));

    const unit = fs.readFileSync(layout.servicePath, "utf8");
    expect(unit).toContain(`Environment="AC_CORE_REMOTE=1"`);
    expect(unit).toContain(`Environment="AC_CORE_LINK_PORT=8443"`);
    expect(unit).toContain(`Environment="AC_CORE_LINK_HOST=0.0.0.0"`);
    expect(unit).toContain(`Environment="AC_CORE_PUBLIC_HOST=10.0.0.5"`);
    expect(unit).toContain(`Environment="AC_USER_DATA_DIR=${layout.dataDir}"`);
    expect(unit).toContain(
      `Environment="AC_CORE_MATERIAL_FILE=${path.join(layout.configDir, "material.json")}"`,
    );
  });

  it("reloads, enables, and starts the unit", async () => {
    const system = fakeSystem();
    await runActanaSetup(options(system));

    const commands = system.calls.map((c) => c.join(" "));
    expect(commands).toContain("systemctl --user daemon-reload");
    expect(commands).toContain("systemctl --user enable actana-core.service");
    expect(commands).toContain("systemctl --user restart actana-core.service");
    expect(commands.indexOf("systemctl --user daemon-reload")).toBeLessThan(
      commands.indexOf("systemctl --user restart actana-core.service"),
    );
  });

  it("never shells out to sudo", async () => {
    const system = fakeSystem();
    await runActanaSetup(options(system));
    expect(system.calls.flat()).not.toContain("sudo");
  });

  it("reports the daemon as listening once its port answers", async () => {
    const result = await runActanaSetup(options(fakeSystem()));
    expect(result.listening).toBe(true);
  });

  it("reports not-listening rather than failing when the port never answers", async () => {
    const system = fakeSystem();
    system.waitForPort = async () => false;
    const result = await runActanaSetup(options(system));
    expect(result.listening).toBe(false);
  });

  it("throws when systemd refuses to start the unit", async () => {
    const system = fakeSystem({
      "systemctl --user restart": { status: 1, stdout: "", stderr: "Job failed" },
    });
    await expect(runActanaSetup(options(system))).rejects.toThrow(/Job failed/);
  });
});

describe("runActanaSetup — linger", () => {
  it("enables linger when it is off, so the daemon survives logout", async () => {
    const system = fakeSystem({ "loginctl show-user": { status: 0, stdout: "Linger=no", stderr: "" } });
    const result = await runActanaSetup(options(system));

    expect(system.calls.map((c) => c.join(" "))).toContain("loginctl enable-linger op");
    expect(result.survivesLogout).toBe(true);
  });

  it("leaves linger alone when it is already on", async () => {
    const system = fakeSystem({
      "loginctl show-user": { status: 0, stdout: "Linger=yes", stderr: "" },
    });
    const result = await runActanaSetup(options(system));

    expect(system.calls.map((c) => c.join(" "))).not.toContain("loginctl enable-linger op");
    expect(result.survivesLogout).toBe(true);
  });

  it("asks first on a TTY, and explains what it is for", async () => {
    const system = fakeSystem({ "loginctl show-user": { status: 0, stdout: "Linger=no", stderr: "" } });
    await runActanaSetup(options(system, { interactive: true, assumeYes: false }));

    expect(system.confirms).toHaveLength(1);
    expect(system.confirms[0]).toMatch(/log out|logout/i);
  });

  it("respects a declined prompt and installs anyway", async () => {
    const system = fakeSystem({ "loginctl show-user": { status: 0, stdout: "Linger=no", stderr: "" } });
    system.answer = false;
    const result = await runActanaSetup(options(system, { interactive: true, assumeYes: false }));

    expect(system.calls.map((c) => c.join(" "))).not.toContain("loginctl enable-linger op");
    expect(result.survivesLogout).toBe(false);
    expect(fs.existsSync(layout.servicePath)).toBe(true);
  });

  it("never prompts when non-interactive — a piped install cannot answer", async () => {
    const system = fakeSystem({ "loginctl show-user": { status: 0, stdout: "Linger=no", stderr: "" } });
    await runActanaSetup(options(system, { interactive: false }));
    expect(system.confirms).toHaveLength(0);
  });

  it("carries on with a warning when enable-linger is refused", async () => {
    const lines: string[] = [];
    const system = fakeSystem({
      "loginctl show-user": { status: 0, stdout: "Linger=no", stderr: "" },
      "loginctl enable-linger": { status: 1, stdout: "", stderr: "Access denied" },
    });
    const result = await runActanaSetup(options(system, { out: (l) => lines.push(l) }));

    expect(result.survivesLogout).toBe(false);
    expect(lines.join("\n")).toMatch(/sudo loginctl enable-linger op/);
  });

  it("reports linger unknown when loginctl is not on the machine at all", async () => {
    const system = fakeSystem({
      "loginctl show-user": { status: 127, stdout: "", stderr: "not found" },
    });
    const result = await runActanaSetup(options(system));
    expect(result.survivesLogout).toBe(false);
  });
});

describe("runActanaSetup — re-running over an existing install", () => {
  it("keeps the pairing token stable so a paired Panel stays paired", async () => {
    const first = await runActanaSetup(options(fakeSystem()));
    const second = await runActanaSetup(options(fakeSystem()));

    const a = decodeRegistrationBlob(first.blob)!;
    const b = decodeRegistrationBlob(second.blob)!;
    expect(b.caCert).toBe(a.caCert);
    expect(b.clientCert).toBe(a.clientCert);
    expect(second.reusedMaterial).toBe(true);
  });

  it("leaves exactly one unit file and one current symlink", async () => {
    await runActanaSetup(options(fakeSystem()));
    await runActanaSetup(options(fakeSystem()));

    expect(fs.readdirSync(layout.serviceDir)).toEqual(["actana-core.service"]);
    expect(fs.lstatSync(layout.currentLink).isSymbolicLink()).toBe(true);
  });

  it("upgrades in place: the new version installs and current follows it", async () => {
    await runActanaSetup(options(fakeSystem()));

    const nextManifest = { ...MANIFEST, version: "0.50.0" };
    const nextRoot = path.join(tmp, "extract", "actana-core-0.50.0-linux-x64");
    makeTarballTree(nextRoot, nextManifest);
    const result = await runActanaSetup(
      options(fakeSystem(), { sourceRoot: nextRoot, manifest: nextManifest }),
    );

    expect(result.installDir).toBe(path.join(layout.versionsDir, "0.50.0"));
    expect(fs.realpathSync(layout.currentLink)).toBe(fs.realpathSync(result.installDir));
    expect(readActanaConfig(layout.configDir)?.version).toBe("0.50.0");
    // The old tree stays put so a failed upgrade has something to roll back to.
    expect(fs.existsSync(path.join(layout.versionsDir, "0.49.0"))).toBe(true);
  });

  it("replaces a half-written tree of the same version rather than merging into it", async () => {
    const installDir = path.join(layout.versionsDir, "0.49.0");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "leftover.txt"), "from a crashed install");

    await runActanaSetup(options(fakeSystem()));

    expect(fs.existsSync(path.join(installDir, "leftover.txt"))).toBe(false);
    expect(fs.existsSync(path.join(installDir, "app", "core-entry.cjs"))).toBe(true);
  });

  it("stops the running daemon before swapping its tree", async () => {
    const system = fakeSystem({
      "systemctl --user is-active": { status: 0, stdout: "active\n", stderr: "" },
    });
    await runActanaSetup(options(system));

    const commands = system.calls.map((c) => c.join(" "));
    expect(commands).toContain("systemctl --user stop actana-core.service");
    expect(commands.indexOf("systemctl --user stop actana-core.service")).toBeLessThan(
      commands.indexOf("systemctl --user restart actana-core.service"),
    );
  });

  it("reissues material when the public host changed — the old cert would not verify", async () => {
    const first = await runActanaSetup(options(fakeSystem()));
    const second = await runActanaSetup(options(fakeSystem(), { publicHost: "10.0.0.9" }));

    expect(second.reusedMaterial).toBe(false);
    expect(decodeRegistrationBlob(second.blob)!.caCert).not.toBe(
      decodeRegistrationBlob(first.blob)!.caCert,
    );
    expect(decodeRegistrationBlob(second.blob)!.endpoint).toBe("wss://10.0.0.9:8443");
  });

  it("survives an existing `current` symlink pointing at a deleted tree", async () => {
    fs.mkdirSync(path.dirname(layout.currentLink), { recursive: true });
    fs.symlinkSync(path.join(layout.versionsDir, "0.0.1"), layout.currentLink);

    const result = await runActanaSetup(options(fakeSystem()));
    expect(fs.realpathSync(layout.currentLink)).toBe(fs.realpathSync(result.installDir));
  });

  it("replaces a stale bin link left by a previous install", async () => {
    fs.mkdirSync(layout.binDir, { recursive: true });
    fs.symlinkSync("/nonexistent/actana", layout.binLink);

    await runActanaSetup(options(fakeSystem()));
    expect(fs.readlinkSync(layout.binLink)).toBe(path.join(layout.currentLink, "bin", "actana"));
  });
});

describe("runActanaSetup — a Core installed before the rename", () => {
  /** The unit `actana setup` wrote when the machine was called a Harness. */
  const LEGACY_UNIT = "actana-harness.service";

  /** Put a pre-rename unit where the old setup left it. */
  function plantLegacyUnit(): string {
    fs.mkdirSync(layout.serviceDir, { recursive: true });
    const legacyPath = path.join(layout.serviceDir, LEGACY_UNIT);
    fs.writeFileSync(legacyPath, "[Unit]\nDescription=Actana Control Harness\n");
    return legacyPath;
  }

  it("removes the old unit before the new one is enabled — never two daemons", async () => {
    const legacyPath = plantLegacyUnit();
    const system = fakeSystem();

    await runActanaSetup(options(system));

    expect(fs.existsSync(legacyPath)).toBe(false);
    const commands = system.calls.map((c) => c.join(" "));
    expect(commands).toContain(`systemctl --user stop ${LEGACY_UNIT}`);
    expect(commands).toContain(`systemctl --user disable ${LEGACY_UNIT}`);
    // The old unit runs out of the same `current` tree and binds the same
    // port, so it has to be gone before the new one is enabled and started.
    expect(commands.indexOf(`systemctl --user stop ${LEGACY_UNIT}`)).toBeLessThan(
      commands.indexOf("systemctl --user enable actana-core.service"),
    );
  });

  it("leaves one unit behind, and it is the Core's", async () => {
    plantLegacyUnit();
    await runActanaSetup(options(fakeSystem()));

    expect(fs.readdirSync(layout.serviceDir)).toEqual(["actana-core.service"]);
  });

  it("tells the operator what it removed rather than doing it silently", async () => {
    plantLegacyUnit();
    const lines: string[] = [];

    await runActanaSetup(options(fakeSystem(), { out: (line) => lines.push(line) }));

    expect(lines.some((line) => line.includes(LEGACY_UNIT))).toBe(true);
  });

  it("does nothing at all on a machine that never had one", async () => {
    const system = fakeSystem();
    await runActanaSetup(options(system));
    await runActanaSetup(options(system));

    expect(system.calls.some((c) => c.join(" ").includes(LEGACY_UNIT))).toBe(false);
  });
});

describe("runActanaSetup — refusals", () => {
  it("refuses a platform whose manifest does not match the machine", async () => {
    await expect(
      runActanaSetup(
        options(fakeSystem(), { manifest: { ...MANIFEST, platform: "darwin", target: "mac-arm64" } }),
      ),
    ).rejects.toThrow(/mac-arm64/);
  });

  it("refuses an arch whose manifest does not match the machine", async () => {
    await expect(
      runActanaSetup(
        options(fakeSystem(), { manifest: { ...MANIFEST, arch: "arm64", target: "linux-arm64" } }),
      ),
    ).rejects.toThrow(/linux-arm64/);
  });

  it("refuses a source tree that is not an extracted tarball", async () => {
    fs.rmSync(path.join(sourceRoot, "app"), { recursive: true, force: true });
    await expect(runActanaSetup(options(fakeSystem()))).rejects.toThrow(/core-entry/);
  });
});

describe("runActanaSetup — macOS", () => {
  const MAC_MANIFEST = { ...MANIFEST, target: "mac-arm64", platform: "darwin", arch: "arm64" };

  /** The same install, told it is on a Mac. */
  function macOptions(system: ActanaSystem, over: Partial<SetupOptions> = {}): SetupOptions {
    const macLayout = resolveActanaLayout({}, home, "darwin");
    return options(system, {
      layout: macLayout,
      platform: "darwin",
      arch: "arm64",
      manifest: MAC_MANIFEST,
      service: createServiceManager({
        platform: "darwin",
        layout: macLayout,
        system,
        user: "op",
        uid: 501,
      }),
      ...over,
    });
  }

  it("writes a LaunchAgent that starts the daemon through the current symlink", async () => {
    const system = fakeSystem();
    const macLayout = resolveActanaLayout({}, home, "darwin");
    await runActanaSetup(macOptions(system));

    const plist = fs.readFileSync(macLayout.servicePath, "utf8");
    expect(macLayout.servicePath).toBe(
      path.join(home, "Library", "LaunchAgents", "com.actana.core.plist"),
    );
    expect(plist).toContain(
      `<string>${path.join(macLayout.currentLink, "bin", "actana")}</string>`,
    );
    expect(plist).toContain("<key>RunAtLoad</key>");
  });

  it("gives the daemon the same env the systemd unit does", async () => {
    const system = fakeSystem();
    const macLayout = resolveActanaLayout({}, home, "darwin");
    await runActanaSetup(macOptions(system));

    const plist = fs.readFileSync(macLayout.servicePath, "utf8");
    for (const key of [
      "AC_CORE_REMOTE",
      "AC_CORE_LINK_PORT",
      "AC_CORE_LINK_HOST",
      "AC_CORE_PUBLIC_HOST",
      "AC_USER_DATA_DIR",
      "AC_CORE_MATERIAL_FILE",
    ]) {
      expect(plist).toContain(`<key>${key}</key>`);
    }
  });

  it("bootstraps the agent into the operator's own launchd domain — no sudo", async () => {
    const system = fakeSystem();
    await runActanaSetup(macOptions(system));

    const commands = system.calls.map((c) => c.join(" "));
    expect(commands).toContain(
      `launchctl bootstrap gui/501 ${path.join(home, "Library", "LaunchAgents", "com.actana.core.plist")}`,
    );
    expect(system.calls.flat()).not.toContain("sudo");
    expect(commands.some((c) => c.startsWith("systemctl"))).toBe(false);
  });

  it("falls back to the per-user domain when the machine has no GUI session", async () => {
    const system = fakeSystem({
      "launchctl print gui/501": { status: 1, stdout: "", stderr: "Could not find domain" },
    });
    await runActanaSetup(macOptions(system));

    const commands = system.calls.map((c) => c.join(" "));
    expect(commands.some((c) => c.startsWith("launchctl bootstrap user/501 "))).toBe(true);
    expect(commands.some((c) => c.startsWith("launchctl bootstrap gui/501 "))).toBe(false);
  });

  it("unloads the old agent before writing the new plist, so a re-run takes effect", async () => {
    const system = fakeSystem();
    await runActanaSetup(macOptions(system));

    const commands = system.calls.map((c) => c.join(" "));
    expect(commands.indexOf("launchctl bootout gui/501/com.actana.core")).toBeLessThan(
      commands.findIndex((c) => c.startsWith("launchctl bootstrap ")),
    );
  });

  it("says the daemon starts at login rather than pretending it survives logout", async () => {
    const result = await runActanaSetup(macOptions(fakeSystem()));

    expect(result.survivesLogout).toBe(false);
    expect(result.serviceName).toBe("com.actana.core");
    expect(result.serviceSummary).toMatch(/login/i);
  });

  it("never prompts on macOS — there is no linger to ask about", async () => {
    const system = fakeSystem();
    await runActanaSetup(macOptions(system, { interactive: true, assumeYes: false }));
    expect(system.confirms).toHaveLength(0);
  });

  it("leaves exactly one plist when re-run over an existing agent", async () => {
    const macLayout = resolveActanaLayout({}, home, "darwin");
    await runActanaSetup(macOptions(fakeSystem()));
    await runActanaSetup(macOptions(fakeSystem()));

    expect(fs.readdirSync(macLayout.serviceDir)).toEqual(["com.actana.core.plist"]);
  });

  it("kickstarts instead of failing when the agent was already bootstrapped", async () => {
    const system = fakeSystem({
      "launchctl bootstrap": { status: 37, stdout: "", stderr: "Bootstrap failed: 37" },
    });
    await runActanaSetup(macOptions(system));

    expect(system.calls.map((c) => c.join(" "))).toContain(
      "launchctl kickstart -k gui/501/com.actana.core",
    );
  });

  it("throws with launchd's own message when the agent cannot be loaded at all", async () => {
    const system = fakeSystem({
      "launchctl bootstrap": { status: 5, stdout: "", stderr: "Input/output error" },
      "launchctl kickstart": { status: 5, stdout: "", stderr: "no such service" },
    });
    await expect(runActanaSetup(macOptions(system))).rejects.toThrow(/Input\/output error/);
  });
});

describe("choosePublicHost", () => {
  const iface = (address: string, family: "IPv4" | "IPv6", internal: boolean) => ({
    address,
    family,
    internal,
    netmask: "",
    mac: "",
    cidr: null,
  });

  it("picks the first non-internal IPv4 — the address a Panel can dial", () => {
    expect(
      choosePublicHost(
        {
          lo: [iface("127.0.0.1", "IPv4", true)],
          eth0: [iface("10.0.0.5", "IPv4", false)],
        },
        "vm-1",
      ),
    ).toBe("10.0.0.5");
  });

  it("skips loopback and link-local addresses", () => {
    expect(
      choosePublicHost(
        {
          lo: [iface("127.0.0.1", "IPv4", true)],
          eth0: [iface("169.254.1.1", "IPv4", false), iface("192.168.1.20", "IPv4", false)],
        },
        "vm-1",
      ),
    ).toBe("192.168.1.20");
  });

  it("falls back to the hostname when no routable IPv4 exists", () => {
    expect(choosePublicHost({ lo: [iface("127.0.0.1", "IPv4", true)] }, "vm-1")).toBe("vm-1");
  });

  it("falls back to localhost when there is not even a hostname", () => {
    expect(choosePublicHost({}, "")).toBe("localhost");
  });
});
