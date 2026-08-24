import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { loadCoreBlob, registryPaths } from "../blob-registry.ts";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate, createPublicKey } from "node:crypto";
import { verifyBearer } from "@actana/shared/core-link-bearer";
import { readActanaConfig } from "../actana-config";
import { resolveActanaLayout, type ActanaLayout } from "../actana-layout";
import { loadMaterial, materialFilePath, persistMaterial } from "@actana/shared/core-material-store";
import { createServiceManager } from "../actana-service";
import {
  runActanaSetup,
  choosePublicHost,
  placeCoreBundle,
  planCorePlacement,
  setupCommandFor,
  type PlacementOptions,
  type SetupOptions,
} from "../actana-setup";
import type { ActanaSystem, CommandResult } from "../actana-system";

const MANIFEST = {
  version: "0.1.0",
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
    // #288 D9: setup registers the Core it installs with this machine's own
    // CLI, so it needs to be told where that registry is. Under the scratch
    // home, like everything else these tests write.
    registry: registryPaths({ HOME: home }, home),
    // #288 D10: the launcher decision reads `PATH`. An empty one means nothing
    // else answers to `actana`, which is the ordinary case.
    env: { HOME: home, PATH: layout.binDir },
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
  sourceRoot = path.join(tmp, "extract", "actana-core-0.1.0-linux-x64");
  fs.mkdirSync(home, { recursive: true });
  makeTarballTree(sourceRoot);
  layout = resolveActanaLayout({}, home, "linux");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── placement, without activation (ADR 0036 C2, #316) ──────────────────────
//
// `install.sh` places a bundle and stops, so placement is a function with its
// own contract rather than the first third of `runActanaSetup`. What is
// asserted here is both halves of "install is not activation": that the tree,
// the `current` symlink and the launcher are all there, **and** that nothing
// which makes this machine a Core is — no config, no material, no unit. A
// placement that quietly did one more thing than it says would be the removed
// tail growing back under a different name.

/** The placement half of the setup options the rest of this file builds. */
function placing(over: Partial<PlacementOptions> = {}): PlacementOptions {
  return {
    layout,
    env: { HOME: home, PATH: layout.binDir },
    sourceRoot,
    manifest: MANIFEST,
    platform: "linux",
    arch: "x64",
    out: () => {},
    ...over,
  };
}

/** Plan and place in one call, the way both callers do. */
function place(over: Partial<PlacementOptions> = {}) {
  const opts = placing(over);
  return placeCoreBundle(opts, planCorePlacement(opts));
}

describe("placeCoreBundle — what `install.sh` leaves behind", () => {
  it("lands the tree under versions/<v>, points current at it, links the launcher", () => {
    const result = place();

    expect(result.installDir).toBe(path.join(layout.versionsDir, "0.1.0"));
    expect(result.version).toBe("0.1.0");
    expect(fs.existsSync(path.join(result.installDir, "app", "core-entry.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(result.installDir, "node", "bin", "node"))).toBe(true);
    expect(fs.realpathSync(layout.currentLink)).toBe(fs.realpathSync(result.installDir));
    expect(fs.readlinkSync(layout.binLink)).toBe(path.join(layout.currentLink, "bin", "actana"));
    expect(result.launcher.outcome).toBe("linked");
  });

  // The other half of the contract, and the one the whole ticket is about.
  it("activates nothing: no config, no material, no unit, no data dir", () => {
    place();

    expect(readActanaConfig(layout.configDir)).toBeNull();
    expect(fs.existsSync(materialFilePath(layout.configDir))).toBe(false);
    expect(fs.existsSync(layout.servicePath)).toBe(false);
    // The data dir is the daemon's, and there is no daemon yet.
    expect(fs.existsSync(layout.dataDir)).toBe(false);
  });

  it("needs no init system, so it works where `setup` could not run at all", () => {
    // `PlacementOptions` has no `service` and no `system` to give it one.
    // Stated as a test because it is the reason placement is separable at all:
    // a bundle can be put on a machine whose init system nothing here supports.
    expect(Object.keys(placing())).not.toContain("service");
    expect(() => place()).not.toThrow();
  });

  it("runs twice over its own output without copying anything", () => {
    const first = place();
    const marker = path.join(first.installDir, "app", "marker");
    fs.writeFileSync(marker, "still here\n");

    // The shape of the two-command install: `setup` runs from the launcher of
    // the tree `install.sh` just placed, so its source *is* its destination.
    const again = place({ sourceRoot: first.installDir });

    expect(again.installDir).toBe(first.installDir);
    expect(fs.readFileSync(marker, "utf8")).toBe("still here\n");
    expect(fs.realpathSync(layout.currentLink)).toBe(fs.realpathSync(first.installDir));
  });

  it("refuses a tree that is not a Core build, before writing anything", () => {
    fs.rmSync(path.join(sourceRoot, "node", "bin", "node"));

    expect(() => place()).toThrow(/not an extracted Core tarball/);
    expect(fs.existsSync(layout.versionsDir)).toBe(false);
    expect(fs.existsSync(layout.currentLink)).toBe(false);
  });

  it("refuses a build for another machine, before writing anything", () => {
    expect(() => place({ arch: "arm64" })).toThrow(/but the machine is/);
    expect(fs.existsSync(layout.versionsDir)).toBe(false);
  });

  // #316's fifth criterion: a failed run leaves the machine as it was found.
  // Two shapes, because they fail at different points and clean up different
  // things — one before the copy starts, one with the staging tree already on
  // disk.
  it("leaves nothing behind when the install root cannot be written", () => {
    // Something else owns `versions` — the shape a hand-made file or a stray
    // mount leaves. `mkdir` refuses and no tree is begun.
    fs.mkdirSync(layout.root, { recursive: true });
    fs.writeFileSync(layout.versionsDir, "not a directory\n");

    expect(() => place()).toThrow();
    expect(fs.statSync(layout.versionsDir).isFile()).toBe(true);
    // Neither link was touched, so nothing points at a tree that is not there.
    expect(fs.existsSync(layout.currentLink)).toBe(false);
    expect(fs.existsSync(layout.binLink)).toBe(false);
  });

  // Skipped as root, where a mode of 000 stops nothing. Everywhere else this
  // is the real thing: the copy gets part way, throws, and has to take its own
  // staging tree and the version directory it was about to become with it.
  it.skipIf(process.getuid?.() === 0)(
    "leaves nothing behind when the copy fails part-way through",
    () => {
      fs.chmodSync(path.join(sourceRoot, "app", "core-entry.cjs"), 0o000);

      expect(() => place()).toThrow();

      const installDir = path.join(layout.versionsDir, "0.1.0");
      expect(fs.existsSync(installDir), "a half-placed tree survived").toBe(false);
      expect(fs.existsSync(`${installDir}.incoming`), "the staging tree survived").toBe(false);
      expect(fs.existsSync(layout.currentLink)).toBe(false);
      expect(fs.existsSync(layout.binLink)).toBe(false);
    },
  );

  // Skipped as root for the same reason as the test above. The failure has to
  // happen *during the copy*: a source `planCorePlacement` refuses throws
  // before `placeCoreBundle` is entered at all, and a test built that way would
  // pass without ever entering the code it is about.
  it.skipIf(process.getuid?.() === 0)(
    "keeps the version that was already installed when a re-place fails mid-copy",
    () => {
      const first = place();
      fs.writeFileSync(path.join(first.installDir, "app", "keep-me"), "installed\n");

      // A second source, same version, well-formed enough to be planned and
      // impossible to copy.
      const second = path.join(tmp, "extract-2", "actana-core-0.1.0-linux-x64");
      makeTarballTree(second);
      fs.chmodSync(path.join(second, "app", "core-entry.cjs"), 0o000);

      expect(() => place({ sourceRoot: second })).toThrow();

      expect(fs.readFileSync(path.join(first.installDir, "app", "keep-me"), "utf8")).toBe(
        "installed\n",
      );
      expect(fs.existsSync(`${first.installDir}.incoming`)).toBe(false);
      expect(fs.existsSync(`${first.installDir}.previous`)).toBe(false);
    },
  );

  // The swap moves the old tree aside rather than deleting it, so that the
  // rename putting the new one in place has something to be undone with. Both
  // scratch paths are this call's to clean up — a `versions/0.1.0.previous`
  // left lying around is a full copy of a Core bundle nobody will ever look at.
  it("leaves neither scratch directory behind when it replaces a tree", () => {
    const first = place();
    fs.writeFileSync(path.join(first.installDir, "app", "old-marker"), "old\n");

    const second = path.join(tmp, "extract-2", "actana-core-0.1.0-linux-x64");
    makeTarballTree(second);
    const again = place({ sourceRoot: second });

    expect(again.installDir).toBe(first.installDir);
    expect(fs.existsSync(path.join(again.installDir, "app", "old-marker"))).toBe(false);
    expect(fs.existsSync(`${again.installDir}.incoming`)).toBe(false);
    expect(fs.existsSync(`${again.installDir}.previous`)).toBe(false);
  });

  it("does not adopt a `.previous` a crashed run left behind", () => {
    const installDir = path.join(layout.versionsDir, "0.1.0");
    fs.mkdirSync(`${installDir}.previous`, { recursive: true });
    fs.writeFileSync(path.join(`${installDir}.previous`, "from-a-crash"), "junk\n");

    const result = place();

    expect(fs.existsSync(`${result.installDir}.previous`)).toBe(false);
    expect(fs.existsSync(path.join(result.installDir, "from-a-crash"))).toBe(false);
  });

  it("does not adopt a staging directory a crashed run left behind", () => {
    const installDir = path.join(layout.versionsDir, "0.1.0");
    fs.mkdirSync(`${installDir}.incoming`, { recursive: true });
    fs.writeFileSync(path.join(`${installDir}.incoming`, "half-copied"), "junk\n");

    const result = place();

    expect(fs.existsSync(`${installDir}.incoming`)).toBe(false);
    expect(fs.existsSync(path.join(result.installDir, "half-copied"))).toBe(false);
  });
});

// **The collision is tested, not reasoned about** (#288 D10, #316 landmine).
// `deploy/core.Dockerfile` sets `NPM_CONFIG_PREFIX=/home/core/.local`, so
// `npm i -g @actana/cli` puts its shim at `$HOME/.local/bin/actana` — the very
// path `resolveActanaLayout` calls `binLink`. `install.sh` reaches that path
// before `setup` does now, so the refusal to clobber has to hold on the
// placement path too, or the CLI-only install this milestone must not break
// gets its launcher deleted by the first bundle install on the same machine.
describe("placeCoreBundle — the launcher path still has one owner", () => {
  /** What `npm i -g` leaves at `<prefix>/bin/actana`: a symlink into its own tree. */
  function plantNpmShim(): string {
    const target = path.join(
      layout.home, ".local", "lib", "node_modules", "@actana", "cli", "bin", "actana.mjs",
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "#!/usr/bin/env node\n");
    fs.mkdirSync(layout.binDir, { recursive: true });
    fs.symlinkSync(target, layout.binLink);
    return target;
  }

  it("does not clobber an `actana` npm put at the very same path", () => {
    expect(layout.binLink).toBe(path.join(layout.home, ".local", "bin", "actana"));
    const shim = plantNpmShim();

    const result = place();

    expect(result.launcher.outcome).toBe("foreign");
    expect(fs.readlinkSync(layout.binLink)).toBe(shim);
    // The bundle still landed: refusing the launcher is not refusing the install.
    expect(fs.realpathSync(layout.currentLink)).toBe(fs.realpathSync(result.installDir));
  });

  it("says so, naming both programs", () => {
    plantNpmShim();
    const said: string[] = [];
    place({ out: (line) => said.push(line) });

    const text = said.join("\n");
    expect(text).toContain(layout.binLink);
    expect(text).toContain(path.join(layout.currentLink, "bin", "actana"));
  });

  it("leaves an `actana` that is only earlier on PATH alone too", () => {
    const elsewhere = path.join(layout.home, "bin");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "actana"), "#!/bin/sh\n");

    const result = place({ env: { HOME: home, PATH: `${elsewhere}:${layout.binDir}` } });

    expect(result.launcher.outcome).toBe("foreign");
    expect(fs.existsSync(layout.binLink)).toBe(false);
  });
});

// #316's fourth criterion. The script reaches "is the launcher findable?"
// *before* setup does now, so the answer has to be in the command it prints
// rather than in a note setup makes afterwards.
describe("setupCommandFor — the next command, runnable as printed", () => {
  const linked = { outcome: "linked", binLink: "", foreignPath: null, note: null } as const;
  const foreign = { outcome: "foreign", binLink: "", foreignPath: "/usr/bin/actana", note: null } as const;

  it("is bare `actana setup` when this install's launcher is the one on PATH", () => {
    expect(setupCommandFor(layout, linked, { PATH: layout.binDir })).toBe("actana setup");
  });

  it("is an absolute path when the launcher's directory is not on PATH", () => {
    // The ordinary state of a fresh machine: `~/.local/bin` does not exist at
    // login, so the shell never added it, so a bare `actana` is not found.
    expect(setupCommandFor(layout, linked, { PATH: "/usr/bin:/bin" })).toBe(
      `${path.join(layout.currentLink, "bin", "actana")} setup`,
    );
  });

  it("is an absolute path when somebody else owns the name, even on PATH", () => {
    // An `actana` from npm has no bundle around it, so `actana setup` there
    // would resolve a release and download one — a different act from
    // activating the bundle that was just placed.
    expect(setupCommandFor(layout, foreign, { PATH: layout.binDir })).toBe(
      `${path.join(layout.currentLink, "bin", "actana")} setup`,
    );
  });

  it("goes through `current`, so it survives the next update", () => {
    const command = setupCommandFor(layout, linked, { PATH: "/usr/bin" });
    expect(command).toContain(layout.currentLink);
    expect(command).not.toContain(layout.versionsDir);
  });

  it("names no PATH at all as not on PATH", () => {
    expect(setupCommandFor(layout, linked, {})).toContain(layout.currentLink);
  });
});

describe("runActanaSetup — the install layout", () => {
  it("installs the tree under the operator's home, versioned", async () => {
    const result = await runActanaSetup(options(fakeSystem()));

    expect(result.installDir).toBe(path.join(layout.versionsDir, "0.1.0"));
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
      version: "0.1.0",
      port: 8443,
      host: "0.0.0.0",
      publicHost: "10.0.0.5",
      label: "vm-1",
      installDir: path.join(layout.versionsDir, "0.1.0"),
      dataDir: layout.dataDir,
    });
  });
});

/**
 * The credential setup wrote into this machine's own registry (#288 D9).
 *
 * Read back out of the registry rather than off the result, because since #287
 * the result carries no credential at all: setup emits nothing for a human to
 * carry, and the registry file is the only place its work lands.
 */
function wiredCredential(result: { wiring: { name: string } }) {
  const loaded = loadCoreBlob(registryPaths({ HOME: home }, home), result.wiring.name);
  if (!loaded.ok) throw new Error(`no registry entry for ${result.wiring.name}: ${loaded.error}`);
  return loaded.blob;
}

describe("runActanaSetup — the credential it wires into the registry", () => {
  it("writes one this machine's own client can dial with", async () => {
    const result = await runActanaSetup(options(fakeSystem()));

    const blob = wiredCredential(result);
    expect(blob.endpoint).toBe("wss://10.0.0.5:8443");
    expect(blob.label).toBe("vm-1");
    expect(blob.caCert).toContain("BEGIN CERTIFICATE");
    expect(blob.clientKey).toContain("PRIVATE KEY");
  });

  // #287: the whole point of the removal is that there is no artifact. A field
  // on the result would be one, whether or not anything printed it today.
  it("returns no credential of any kind to its caller", async () => {
    const result = await runActanaSetup(options(fakeSystem()));
    expect(result).not.toHaveProperty("blob");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });

  it("signs the bearer with the secret the daemon will load from disk", async () => {
    const result = await runActanaSetup(options(fakeSystem()));

    const blob = wiredCredential(result);
    const material = loadMaterial(layout.configDir);
    expect(material).not.toBeNull();
    const verified = verifyBearer(blob.bearer, material!.bearerSecret);
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
  it("keeps the pairing credentials stable so a paired client stays paired", async () => {
    const first = await runActanaSetup(options(fakeSystem()));
    const a = wiredCredential(first);
    const second = await runActanaSetup(options(fakeSystem()));
    const b = wiredCredential(second);
    expect(b.caCert).toBe(a.caCert);
    expect(b.clientCert).toBe(a.clientCert);
    expect(second.materialOutcome).toBe("reused");
  });

  it("leaves exactly one unit file and one current symlink", async () => {
    await runActanaSetup(options(fakeSystem()));
    await runActanaSetup(options(fakeSystem()));

    expect(fs.readdirSync(layout.serviceDir)).toEqual(["actana-core.service"]);
    expect(fs.lstatSync(layout.currentLink).isSymbolicLink()).toBe(true);
  });

  it("upgrades in place: the new version installs and current follows it", async () => {
    await runActanaSetup(options(fakeSystem()));

    const nextManifest = { ...MANIFEST, version: "0.2.0" };
    const nextRoot = path.join(tmp, "extract", "actana-core-0.2.0-linux-x64");
    makeTarballTree(nextRoot, nextManifest);
    const result = await runActanaSetup(
      options(fakeSystem(), { sourceRoot: nextRoot, manifest: nextManifest }),
    );

    expect(result.installDir).toBe(path.join(layout.versionsDir, "0.2.0"));
    expect(fs.realpathSync(layout.currentLink)).toBe(fs.realpathSync(result.installDir));
    expect(readActanaConfig(layout.configDir)?.version).toBe("0.2.0");
    // The old tree stays put so a failed upgrade has something to roll back to.
    expect(fs.existsSync(path.join(layout.versionsDir, "0.1.0"))).toBe(true);
  });

  it("replaces a half-written tree of the same version rather than merging into it", async () => {
    const installDir = path.join(layout.versionsDir, "0.1.0");
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

  it("re-issues the server cert when the public host changed — the old SAN would not verify", async () => {
    await runActanaSetup(options(fakeSystem()));
    const before = loadMaterial(layout.configDir)!;

    const second = await runActanaSetup(options(fakeSystem(), { publicHost: "10.0.0.9" }));

    const after = loadMaterial(layout.configDir)!;
    expect(second.materialOutcome).toBe("reissued");
    expect(after.serverCert).not.toBe(before.serverCert);
    expect(new X509Certificate(after.serverCert).subjectAltName).toContain("10.0.0.9");
    expect(wiredCredential(second).endpoint).toBe("wss://10.0.0.9:8443");
  });

  // The regression this ticket exists for (ADR 0016 D18): re-minting on a host
  // change locked out every paired Panel, and in a container a typo'd env var
  // fires it. Nothing about the identity may change here.
  it("keeps the identity across a host change — no new CA, coreId or bearer secret", async () => {
    const first = await runActanaSetup(options(fakeSystem()));
    const before = loadMaterial(layout.configDir)!;
    const { caCert: caBefore, clientCert: clientCertBefore } = wiredCredential(first);

    const second = await runActanaSetup(options(fakeSystem(), { publicHost: "10.0.0.9" }));

    const after = loadMaterial(layout.configDir)!;
    expect(after.coreId).toBe(before.coreId);
    expect(after.bearerSecret).toBe(before.bearerSecret);
    expect(after.caCert).toBe(before.caCert);
    expect(after.caKey).toBe(before.caKey);
    expect(after.clientCert).toBe(before.clientCert);
    expect(after.clientKey).toBe(before.clientKey);
    expect(second.materialOutcome).toBe("reissued");

    expect(wiredCredential(second).caCert).toBe(caBefore);
    expect(wiredCredential(second).clientCert).toBe(clientCertBefore);
  });

  it("a Panel paired before the move still validates the Core against its pinned CA", async () => {
    const first = await runActanaSetup(options(fakeSystem()));
    const pinnedCa = wiredCredential(first).caCert;

    await runActanaSetup(options(fakeSystem(), { publicHost: "10.0.0.9" }));

    const server = new X509Certificate(loadMaterial(layout.configDir)!.serverCert);
    expect(server.verify(createPublicKey(pinnedCa))).toBe(true);
  });

  it("re-issues rather than re-mints for material predating the recorded host", async () => {
    await runActanaSetup(options(fakeSystem()));
    // Material written before `serverHost` existed: the config setup wrote
    // beside it is what says which host the cert was signed for.
    const legacy = loadMaterial(layout.configDir)!;
    persistMaterial(layout.configDir, { ...legacy, serverHost: "" });

    const same = await runActanaSetup(options(fakeSystem()));
    expect(same.materialOutcome).toBe("reused");
    expect(loadMaterial(layout.configDir)!.serverCert).toBe(legacy.serverCert);

    persistMaterial(layout.configDir, { ...legacy, serverHost: "" });
    const moved = await runActanaSetup(options(fakeSystem(), { publicHost: "10.0.0.9" }));

    expect(moved.materialOutcome).toBe("reissued");
    expect(loadMaterial(layout.configDir)!.coreId).toBe(legacy.coreId);
  });

  it("says it re-issued the certificate rather than announcing a new token", async () => {
    const lines: string[] = [];
    await runActanaSetup(options(fakeSystem()));
    await runActanaSetup(
      options(fakeSystem(), { publicHost: "10.0.0.9", out: (l) => lines.push(l) }),
    );

    const said = lines.join("\n");
    expect(said).toContain("10.0.0.9");
    expect(said).toMatch(/re-issuing this Core's server certificate/i);
  });

  it("survives an existing `current` symlink pointing at a deleted tree", async () => {
    fs.mkdirSync(path.dirname(layout.currentLink), { recursive: true });
    fs.symlinkSync(path.join(layout.versionsDir, "0.0.1"), layout.currentLink);

    const result = await runActanaSetup(options(fakeSystem()));
    expect(fs.realpathSync(layout.currentLink)).toBe(fs.realpathSync(result.installDir));
  });

  it("replaces a stale bin link left by a previous install", async () => {
    fs.mkdirSync(layout.binDir, { recursive: true });
    // Dangling, and pointing into this layout's own root — which is what a
    // previous install of *this* Core leaves behind when its version directory
    // has been deleted by hand. Ownership is decided by where the link points
    // (#288 D10), so this one is setup's to repoint.
    fs.symlinkSync(path.join(layout.root, "versions", "0.0.1", "bin", "actana"), layout.binLink);

    await runActanaSetup(options(fakeSystem()));
    expect(fs.readlinkSync(layout.binLink)).toBe(path.join(layout.currentLink, "bin", "actana"));
  });
});

// ─── Who owns `<binDir>/actana` (#288 D10) ──────────────────────────────────
//
// **Tested in the container's shape, because that is where the collision is
// real.** `deploy/core.Dockerfile` sets `NPM_CONFIG_PREFIX=/home/core/.local`
// and the layout resolves `binLink` to `$HOME/.local/bin/actana` — the same
// directory. So an `npm i -g @actana/cli` inside a container Core puts its shim
// exactly where setup wants its symlink, and which of the two ends up there was
// decided by whichever ran last.
//
// These run against real files rather than a fake `exists`, deliberately: the
// question is what `lstat` and `readlink` say about a path two installers both
// wrote to, and a stub filesystem would be answering a different question.

describe("runActanaSetup — the launcher path has one owner (#288 D10)", () => {
  /** What `npm i -g` leaves at `<prefix>/bin/actana`: a symlink into its own tree. */
  function plantNpmShim(): string {
    const target = path.join(layout.home, ".local", "lib", "node_modules", "@actana", "cli", "bin", "actana.mjs");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "#!/usr/bin/env node\n");
    fs.mkdirSync(layout.binDir, { recursive: true });
    fs.symlinkSync(target, layout.binLink);
    return target;
  }

  it("does not clobber an `actana` npm put at the very same path", async () => {
    // The container's shape exactly: `binLink`'s directory IS the npm prefix's
    // bin, so the two installers are fighting over one filename.
    expect(layout.binLink).toBe(path.join(layout.home, ".local", "bin", "actana"));
    const shim = plantNpmShim();

    const result = await runActanaSetup(options(fakeSystem()));

    expect(result.launcher.outcome).toBe("foreign");
    // Not repointed, not deleted, not moved aside.
    expect(fs.readlinkSync(layout.binLink)).toBe(shim);
  });

  it("says so plainly, and names this install's own launcher", async () => {
    plantNpmShim();
    const said: string[] = [];
    await runActanaSetup(options(fakeSystem(), { out: (line) => said.push(line) }));

    const text = said.join("\n");
    // An operator who is not told has a Core whose `actana` is not the one
    // setup just installed, and no way to find that out from the output.
    expect(text).toContain(layout.binLink);
    expect(text).toContain(path.join(layout.currentLink, "bin", "actana"));
  });

  it("leaves an `actana` that is only on PATH alone too", async () => {
    // The other spelling of the same collision: nothing at `binLink`, but a
    // different directory earlier on `PATH` already answers to `actana`. Writing
    // the symlink would be legal and useless — the other one still wins — so
    // setup writes nothing and says which one is answering.
    const elsewhere = path.join(layout.home, "bin");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "actana"), "#!/bin/sh\n");

    const said: string[] = [];
    const result = await runActanaSetup(
      options(fakeSystem(), {
        env: { HOME: layout.home, PATH: `${elsewhere}:${layout.binDir}` },
        out: (line) => said.push(line),
      }),
    );

    expect(result.launcher.outcome).toBe("foreign");
    expect(fs.existsSync(layout.binLink)).toBe(false);
    expect(said.join("\n")).toContain(path.join(elsewhere, "actana"));
  });

  it("writes the symlink when nothing else answers to the name", async () => {
    const result = await runActanaSetup(options(fakeSystem()));
    expect(result.launcher.outcome).toBe("linked");
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
