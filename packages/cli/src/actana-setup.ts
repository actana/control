// `actana setup` — turning a placed Core bundle into a running, pairable Core.
//
// **Install is not activation, and this file is where the seam is** (ADR 0036
// C2, #316). Two jobs used to be one function: *placing* a bundle — the
// versioned `versions/<v>` tree, the `current` symlink, the `~/.local/bin`
// launcher — and *activating* the machine as a Core — mTLS material, a unit or
// a LaunchAgent, lingering, the daemon, registration. `install.sh` wanted the
// first without the second and had no way to ask for it, so it ran `setup` and
// got both.
//
// So placement is `planCorePlacement` + `placeCoreBundle` below, `actana place`
// is the verb that stops there, and `runActanaSetup` calls the same two
// functions before it activates anything. One implementation, entered at two
// points — the arrangement `actana-install.ts` already uses for the download
// half. **The layout is never resolved anywhere but `actana-layout.ts`**: a
// second copy of those rules in POSIX sh is the failure this repository
// already refuses for release resolution.
//
// Everything happens under the operator's home and nothing shells to sudo, on
// Linux and on macOS alike. The one privilege-adjacent step is Linux's
// `loginctl enable-linger`, which is what makes the daemon survive logout; it
// is prompted on a TTY, attempted without sudo, and downgraded to a printed
// instruction if the machine refuses. macOS has no equivalent that stays
// sudo-less — see `actana-service.ts`.
//
// The init system itself is behind `ActanaServiceManager`, so what is left in
// this file is the part that is the same everywhere: lay out the tree, resolve
// the material, write the config, register the service, and wire the Core it
// just installed into this machine's own registry.
//
// **Setup emits no credential.** It used to end by printing one base64 blob for
// a human to carry to a Panel; #287 deleted that, along with the `blob` field
// this function used to return. A client — a Panel, another machine's `actana`
// — enrolls by running `actana pair new` here and spending the code it prints.
// The one credential setup still writes is this machine's own, straight into
// the registry at 0600, and it never passes through an output sink.
//
// The install is versioned — `versions/<v>` with a `current` symlink — so
// re-running over an existing install lands the new tree beside the old one
// and swaps by repointing one link. Re-running deliberately REUSES the existing
// material: regenerating would lock out every client already paired with this
// Core. A changed public host list re-signs the server cert from
// that same CA and nothing else (ADR 0016 D18). Minting fresh credentials is
// `actana token regenerate` (issue 06), an explicit act.

import * as fs from "node:fs";
import * as path from "node:path";
import { signBearer, type BearerSecret } from "@actana/shared/core-link-bearer";
import { formatPublicHosts, primaryPublicHost } from "@actana/shared/public-hosts";
import {
  checkMaterialIdentity,
  loadMaterial,
  materialFilePath,
  checkServerCertHost,
  mintFreshMaterial,
  persistMaterial,
  reissueServerCert,
  type PersistedMaterial,
} from "@actana/shared/core-material-store";
import { offerHarnessInstalls, type HarnessInstallOutcome } from "./actana-harnesses.ts";
import {
  configPublicHosts,
  endpointFor,
  readActanaConfig,
  writeActanaConfig,
} from "./actana-config.ts";
import { binDirOnPath, installDirFor, type ActanaLayout } from "./actana-layout.ts";
import {
  installTree,
  lstatOrNull,
  missingTreeFile,
  pointSymlink,
  realpathOrNull,
} from "./actana-tree.ts";
import { claimLauncher, type LauncherClaim } from "./actana-launcher.ts";
import { wireLocalCore, type LocalCoreWiring } from "./local-core-wiring.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaServiceManager } from "./actana-service.ts";
import type { CoreManifest } from "./actana-manifest.ts";
import type { ActanaSystem } from "./actana-system.ts";
import type { Harness } from "@actana/shared/domain";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/sdk/core-link-frames";

/** Bearer validity. The Panel re-handshakes on expiry; a year is a long lease. */
const BEARER_DAYS = 365;

/** How long setup waits for the daemon's port to answer before saying so. */
const LISTEN_TIMEOUT_MS = 30_000;

/**
 * What placing a bundle needs — and deliberately nothing more.
 *
 * No registry, no service manager, no port, no public host: placement writes a
 * tree, a symlink and possibly a launcher, and none of those is a decision
 * about what this machine *is*. `SetupOptions` is this plus the activation
 * half, so `actana place` and `actana setup` cannot drift apart on where
 * things go.
 */
export type PlacementOptions = {
  layout: ActanaLayout;
  /** The `PATH` this run was given, for deciding who owns the launcher. */
  env: NodeJS.ProcessEnv;
  /** The extracted tarball tree being placed. */
  sourceRoot: string;
  /** That tree's `core-manifest.json`. */
  manifest: CoreManifest;
  platform: NodeJS.Platform;
  arch: string;
  /** Progress and warnings for the operator. */
  out: (line: string) => void;
};

export type SetupOptions = PlacementOptions & {
  /**
   * Where this machine's client half keeps its Cores (#288 D9).
   *
   * Setup writes the credential it mints into it, so the Core it just installed
   * is one this machine's `actana core ls` already knows about — no credential
   * hand-carried from one half of this command into the other.
   */
  registry: RegistryPaths;
  port: number;
  /** The address the daemon binds. */
  host: string;
  /**
   * The addresses a client dials — every one of them a SAN on the cert, the
   * first of them the endpoint (#347).
   *
   * A list because `--public-host core,10.0.0.5` is one Core reachable two ways
   * at once. One entry is the case that has not changed: it mints the
   * certificate it always minted, records the host it always recorded, and
   * prints the endpoint it always printed.
   */
  publicHosts: readonly string[];
  label: string;
  /** Skip prompts and take the recommended answer. */
  assumeYes: boolean;
  /** Whether there is a terminal to prompt on. */
  interactive: boolean;
  /** Harnesses named with `--with-<harness>` — installed without asking. */
  requestedHarnesses: readonly Harness[];
  /** `--no-harnesses` — install nothing and offer nothing. */
  noHarnesses: boolean;
  /** The Core's own PATH probe — the source of truth for what is missing. */
  probeHarnesses: () => CoreLinkHarnessAvailabilityMap;
  system: ActanaSystem;
  /** This machine's init system — systemd on Linux, launchd on macOS. */
  service: ActanaServiceManager;
};

/** Where a bundle is going, and whether the tree itself has to be written. */
export type PlacementPlan = {
  /** `versions/<version>` under this layout's root. */
  installDir: string;
  /** The extracted tree, with symlinks resolved. */
  source: string;
  /**
   * False when the source *is* the install directory — a `setup` run by the
   * launcher of an install that `install.sh` already placed, which is the
   * ordinary shape of the two-command install (ADR 0036 C2).
   */
  replacingTree: boolean;
};

/** What a placement put on the machine. Nothing here is running. */
export type PlacementResult = {
  /** The version that is now on disk — the tree's, not this CLI's (#288 D10). */
  version: string;
  installDir: string;
  /** Whether `<binDir>/actana` was linked, or left to whoever owns it (#288 D10). */
  launcher: LauncherClaim;
};

/**
 * What `actana setup` did to this machine's pairing material.
 *
 * `re-minted` is the recovery path (#348): the material on disk could not have
 * served TLS at all, so it was replaced rather than re-blessed. Its own outcome
 * because it is the one that costs the operator something — every paired client
 * has to pair again — and a caller that reported it as an ordinary `minted`
 * would leave them to find that out from a client that stopped working.
 */
export type MaterialOutcome = "minted" | "reused" | "reissued" | "re-minted";

export type SetupResult = {
  /** The version that is now installed — the tree's, not this CLI's (#288 D10). */
  version: string;
  installDir: string;
  /** The unit / plist that was written. */
  servicePath: string;
  /** What the service is called: `actana-core.service`, `com.actana.core`. */
  serviceName: string;
  /** How it was registered — `enabled, lingering`, `loaded, starts at login`. */
  serviceSummary: string;
  /** Whether the daemon will survive logout. */
  survivesLogout: boolean;
  /**
   * What this run did to the pairing material:
   *
   * - `minted` — a new identity; there was nothing to keep.
   * - `reused` — the existing one, untouched; a paired Panel stays paired.
   * - `reissued` — the existing identity, with a server cert re-signed for a
   *   public host that moved. A paired Panel still trusts this Core but is
   *   dialling the address it paired with.
   */
  materialOutcome: MaterialOutcome;
  /** Whether the daemon's port answered before the timeout. */
  listening: boolean;
  /** What became of each managed Harness during the offer round. */
  agents: HarnessInstallOutcome[];
  /** Whether `<binDir>/actana` was linked, or left to whoever owns it (#288 D10). */
  launcher: LauncherClaim;
  /** How this Core was registered with this machine's own CLI (#288 D9). */
  wiring: LocalCoreWiring;
};

/**
 * Guess the address a Panel can reach this machine on: the first routable
 * IPv4 the host has, else its hostname, else localhost.
 *
 * A guess is right often enough to matter (cloud VMs, LAN boxes) and wrong
 * loudly enough to fix (`--public-host`) when it is not, which beats making
 * every install answer a question most operators would answer this way.
 */
export function choosePublicHost(
  interfaces: NodeJS.Dict<{ address: string; family: string; internal: boolean }[]>,
  hostname: string,
): string {
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      // 169.254/16 is what a host assigns itself when DHCP failed — reachable
      // by nothing the operator cares about.
      if (address.address.startsWith("169.254.")) continue;
      return address.address;
    }
  }
  return hostname || "localhost";
}

/**
 * Load the existing pairing material, or mint fresh material.
 *
 * Reuse is the default and the point: an operator who re-runs setup must not
 * have to re-pair. A public host the existing server cert's SAN does not cover
 * would fail TLS hostname verification on the Panel's next dial, so that cert
 * is re-issued from the CA already on disk — and only that cert. The CA, the
 * bearer secret, the `coreId` and the Panel's client cert survive, so the Panel
 * still validates this Core against the CA it pinned (ADR 0016 D18). Minting a
 * whole new identity is what `actana token regenerate` is for.
 *
 * Material written before D18 does not record the host its cert was signed for;
 * the config setup wrote alongside it does, so that stands in for it.
 *
 * The one thing reuse cannot survive is material that could never have worked.
 * See the first branch: that is the whole of what makes `actana setup` an
 * honest answer to a daemon that refused to boot (#348).
 */
async function resolveMaterial(
  opts: SetupOptions,
): Promise<{ material: PersistedMaterial; outcome: MaterialOutcome }> {
  const existing = loadMaterial(opts.layout.configDir);
  if (!existing) {
    return { material: await mintFreshMaterial(opts.publicHosts), outcome: "minted" };
  }

  // The recovery path, and the reason `setup` can be named as a remedy at all
  // (#348). Everything below this reuses the identity on disk — `reissueServerCert`
  // included, which signs a new leaf with the *existing* CA and key. That is
  // right for material that works and useless for material that cannot: a
  // daemon told to boot on it refuses, the operator is told to run `setup`, and
  // `setup` hands back what it was already given. So the file is checked with
  // the same function the daemon boots with, and material that could never
  // serve TLS is replaced instead of re-blessed.
  const issue = checkMaterialIdentity(existing);
  if (issue?.severity === "unusable") {
    opts.out(`This Core's material cannot be served: ${issue.message}`);
    // The same confirmation `actana token regenerate` asks before the same
    // loss, because it is the same loss — and it is a loss the operator has
    // no way around here: the alternative to fresh material is a daemon that
    // will not boot.
    if (opts.interactive && !opts.assumeYes) {
      const yes = await opts.system.confirm(
        "Mint this Core a fresh identity? Every client paired with it is locked out until " +
          "it pairs again.",
        true,
      );
      if (!yes) {
        throw new Error(
          "Left this Core's material alone, so setup stopped: the daemon will not boot on " +
            `it. Re-run and accept, or remove ${materialFilePath(opts.layout.configDir)} and ` +
            "run setup again.",
        );
      }
    }
    return { material: await mintFreshMaterial(opts.publicHosts), outcome: "re-minted" };
  }
  // Usable, just not ours — pre-rename material is the case that matters, and
  // it is kept. Said out loud because the operator should know what their Core
  // is presenting, and because `actana token regenerate` is how they change it.
  if (issue) opts.out(issue.message);

  const previous = readActanaConfig(opts.layout.configDir);
  const check = checkServerCertHost(
    existing,
    opts.publicHosts,
    previous ? configPublicHosts(previous) : undefined,
  );
  if (check === "covered") {
    // Backfilled for material that predates the record: the config setup wrote
    // beside it is what proved the cert covers these hosts, so record the answer.
    return { material: { ...existing, serverHosts: [...opts.publicHosts] }, outcome: "reused" };
  }

  const wanted = formatPublicHosts(opts.publicHosts);
  opts.out(
    check === "moved"
      ? `Public host changed to ${wanted} — re-issuing this Core's server ` +
          "certificate from its own CA."
      : "This Core's material does not record which host its certificate was signed " +
          `for — re-issuing it for ${wanted} from its own CA.`,
  );
  return {
    material: await reissueServerCert(existing, opts.publicHosts),
    outcome: "reissued",
  };
}

// ─── placement: what `actana place` does, and what `setup` does first ───────

/**
 * Where a bundle is going, decided before a single byte is written.
 *
 * Split from {@link placeCoreBundle} so the caller can act between deciding
 * and writing: `runActanaSetup` takes out a pre-rename unit and stops a running
 * daemon in that gap, and neither belongs to placement. Every refusal —
 * wrong platform, incomplete tree, unusable version string — happens here, so
 * a plan that came back is a plan that can be carried out.
 */
export function planCorePlacement(opts: PlacementOptions): PlacementPlan {
  const { layout, manifest } = opts;

  if (manifest.platform !== opts.platform || manifest.arch !== opts.arch) {
    throw new Error(
      `this is a ${manifest.target} build (${manifest.platform}/${manifest.arch}) but the ` +
        `machine is ${opts.platform}/${opts.arch} — download the matching tarball`,
    );
  }
  const missing = missingTreeFile(opts.sourceRoot);
  if (missing) {
    throw new Error(`${opts.sourceRoot} is not an extracted Core tarball: no ${missing}`);
  }

  const installDir = installDirFor(layout, manifest.version);
  const source = realpathOrNull(opts.sourceRoot) ?? opts.sourceRoot;
  return { installDir, source, replacingTree: source !== realpathOrNull(installDir) };
}

/**
 * Put the bundle where it lives and link the launcher. Activates nothing.
 *
 * This is the whole of what survives `install.sh`: without it the extracted
 * tree is deleted by the script's own EXIT trap and the machine is exactly as
 * it was found. Nothing here writes config, mints material, or asks an init
 * system for anything — see the file header.
 *
 * **A failed placement leaves the machine as it was found.** `installTree` owns
 * that: the copy lands in `<installDir>.incoming`, the tree it replaces is
 * moved aside rather than deleted, and either the new tree arrives or the old
 * one is put back. What is left here is the one thing that module cannot know
 * — whether the version directory existed before this call — so a directory
 * this call brought into being does not survive a failure. `current` and the
 * launcher are only touched once the tree is complete, so neither can end up
 * pointing at something that is not there.
 */
export function placeCoreBundle(opts: PlacementOptions, plan: PlacementPlan): PlacementResult {
  const { layout, manifest } = opts;
  const hadInstallDir = lstatOrNull(plan.installDir) !== null;

  try {
    if (plan.replacingTree) installTree(plan.source, plan.installDir);
  } catch (err) {
    // `installTree` cleans up after itself and restores what it displaced, so
    // this is the belt to its braces: a version directory that did not exist
    // before this call does not exist after it failed. An install that was
    // already there is never this failure's to delete.
    if (!hadInstallDir) fs.rmSync(plan.installDir, { recursive: true, force: true });
    throw err;
  }

  pointSymlink(layout.currentLink, plan.installDir);
  // Not an unconditional symlink any more: `<binDir>/actana` may already be
  // somebody else's, and in the Core image it is the very directory
  // `NPM_CONFIG_PREFIX` puts npm's global shims in (#288 D10).
  const launcher = claimLauncher(layout, opts.env);
  if (launcher.note) opts.out(launcher.note);

  return { version: manifest.version, installDir: plan.installDir, launcher };
}

/**
 * The `actana setup` line to print after placing a bundle, runnable as printed.
 *
 * A bare `actana` is only correct when this install's own launcher is the one
 * that answers to that name *and* its directory is on `PATH`. Otherwise the
 * operator gets a path: through `current`, so it keeps working after the next
 * update repoints that link. Today `setup` reports the not-on-PATH condition
 * after it has already run; `install.sh` now reaches it first, and a next
 * command that is not found is a dead end rather than a note (#316).
 */
export function setupCommandFor(
  layout: ActanaLayout,
  launcher: LauncherClaim,
  env: NodeJS.ProcessEnv,
): string {
  const usable = launcher.outcome === "linked" && binDirOnPath(layout.binDir, env.PATH);
  return usable ? "actana setup" : `${path.join(layout.currentLink, "bin", "actana")} setup`;
}

/** Install, register, start, and pair this machine. */
export async function runActanaSetup(opts: SetupOptions): Promise<SetupResult> {
  const { layout, manifest, service } = opts;

  const plan = planCorePlacement(opts);

  // A machine installed before the Harness → Core rename has a second service
  // under the old name, running out of this same tree and binding this same
  // port — so it goes first, before the tree is swapped under it and long
  // before the new unit tries to claim the socket. Temporary cleanup, deleted
  // with `removeLegacyUnit` itself; `LEGACY_UNIT_NAME` says when.
  const legacy = service.removeLegacyUnit();
  if (legacy) opts.out(`Removed ${legacy}, left by an install from before the rename.`);

  // Swapping the tree under a running daemon works on both platforms (the open
  // inodes survive) but leaves it executing a version that no longer exists on
  // disk. Stop first so the restart below is the only thing that brings it back.
  if (plan.replacingTree && service.isActive()) {
    opts.out("Stopping the running Core before upgrading it…");
    service.stop();
  }

  // The same placement `actana place` performs, and the same one `install.sh`
  // has already performed when setup is the operator's second command: it is
  // idempotent, so running it again over its own output is a no-op plus two
  // symlink writes.
  const { installDir, launcher } = placeCoreBundle(opts, plan);
  fs.mkdirSync(layout.dataDir, { recursive: true });

  const { material, outcome } = await resolveMaterial(opts);
  persistMaterial(layout.configDir, material);

  const config = {
    version: manifest.version,
    port: opts.port,
    host: opts.host,
    publicHost: primaryPublicHost(opts.publicHosts),
    publicHosts: [...opts.publicHosts],
    label: opts.label,
    installDir,
    dataDir: layout.dataDir,
  };
  writeActanaConfig(layout.configDir, config);

  service.install({
    description: "Actana Control Core",
    // Through `current`, not the versioned path: an update repoints the
    // symlink and the service definition needs no rewrite.
    argv: [path.join(layout.currentLink, "bin", "actana"), "daemon"],
    workingDirectory: layout.home,
    environment: {
      AC_CORE_REMOTE: "1",
      AC_CORE_LINK_PORT: String(opts.port),
      AC_CORE_LINK_HOST: opts.host,
      // The whole list, in the one variable the daemon reads it from. A single
      // host joins to itself, so a unit written for a one-address Core is the
      // unit that was always written for it (#347).
      AC_CORE_PUBLIC_HOST: opts.publicHosts.join(","),
      AC_USER_DATA_DIR: layout.dataDir,
      AC_CORE_MATERIAL_FILE: materialFilePath(layout.configDir),
    },
  });

  const persistence = await service.ensurePersistence({
    interactive: opts.interactive,
    assumeYes: opts.assumeYes,
    out: opts.out,
  });

  // Before the daemon starts, so its very first availability probe already
  // sees whatever the operator just agreed to install — no second probe, no
  // restart, and a Panel that pairs a moment later reads the true picture.
  const agents = await offerHarnessInstalls({
    availability: opts.probeHarnesses(),
    requested: opts.requestedHarnesses,
    noHarnesses: opts.noHarnesses,
    assumeYes: opts.assumeYes,
    interactive: opts.interactive,
    platform: opts.platform,
    system: opts.system,
    homeDir: layout.home,
    out: opts.out,
  });

  service.enableAndStart();

  const listening = await opts.system.waitForPort(opts.port, LISTEN_TIMEOUT_MS);

  const bearer = signBearer(
    { coreId: material.coreId, exp: Date.now() + BEARER_DAYS * 24 * 60 * 60 * 1000 },
    material.bearerSecret as BearerSecret,
  );

  // #288 D9. The credential never reaches an output sink: it goes straight into
  // a 0600 file in the registry, and what setup prints about it is a name and
  // whether it is selected. There is no second copy for anyone to carry (#287).
  const wiring = wireLocalCore(opts.registry, opts.label, {
    endpoint: endpointFor(config),
    label: opts.label,
    caCert: material.caCert,
    clientCert: material.clientCert,
    clientKey: material.clientKey,
    bearer,
  });

  return {
    version: manifest.version,
    installDir,
    servicePath: service.filePath,
    serviceName: service.name,
    serviceSummary: persistence.summary,
    survivesLogout: persistence.survivesLogout,
    materialOutcome: outcome,
    listening,
    agents,
    launcher,
    wiring,
  };
}
