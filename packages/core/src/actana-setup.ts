// `actana setup` — turning the extracted tarball into a running, pairable Core.
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
// the material, write the config, register the service, print the token.
//
// The install is versioned — `versions/<v>` with a `current` symlink — so
// re-running over an existing install lands the new tree beside the old one
// and swaps by repointing one link. Re-running deliberately REUSES the existing
// material: regenerating would invalidate the pairing token an operator already
// pasted into their Panel. A changed publicHost re-signs the server cert from
// that same CA and nothing else (ADR 0016 D18). Minting fresh credentials is
// `actana token regenerate` (issue 06), an explicit act.

import * as fs from "node:fs";
import * as path from "node:path";
import { signBearer, type BearerSecret } from "@actana/shared/core-link-bearer";
import { encodeRegistrationBlob } from "@actana/shared/registration-blob";
import {
  loadMaterial,
  materialFilePath,
  mintFreshMaterial,
  persistMaterial,
  reissueServerCert,
  serverCertCoversHost,
  type PersistedMaterial,
} from "./core-material-store";
import { offerHarnessInstalls, type HarnessInstallOutcome } from "./actana-harnesses";
import { endpointFor, readActanaConfig, writeActanaConfig } from "./actana-config";
import { installDirFor, type ActanaLayout } from "./actana-layout";
import { installTree, missingTreeFile, pointSymlink, realpathOrNull } from "./actana-tree";
import type { ActanaServiceManager } from "./actana-service";
import type { CoreManifest } from "./actana-manifest";
import type { ActanaSystem } from "./actana-system";
import type { Harness } from "@actana/shared/domain";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/shared/core-link-frames";

/** Bearer validity. The Panel re-handshakes on expiry; a year is a long lease. */
const BEARER_DAYS = 365;

/** How long setup waits for the daemon's port to answer before saying so. */
const LISTEN_TIMEOUT_MS = 30_000;

export type SetupOptions = {
  layout: ActanaLayout;
  /** The extracted tarball tree setup is running from. */
  sourceRoot: string;
  /** That tree's `core-manifest.json`. */
  manifest: CoreManifest;
  port: number;
  /** The address the daemon binds. */
  host: string;
  /** The address a Panel dials — goes in the cert SAN and the pairing token. */
  publicHost: string;
  label: string;
  platform: NodeJS.Platform;
  arch: string;
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
  /** Progress and warnings for the operator. */
  out: (line: string) => void;
};

export type SetupResult = {
  /** The pairing token — base64 of the Registration blob. */
  blob: string;
  installDir: string;
  /** The unit / plist that was written. */
  servicePath: string;
  /** What the service is called: `actana-core.service`, `com.actana.core`. */
  serviceName: string;
  /** How it was registered — `enabled, lingering`, `loaded, starts at login`. */
  serviceSummary: string;
  /** Whether the daemon will survive logout. */
  survivesLogout: boolean;
  /** True when the existing pairing material was kept (a paired Panel stays paired). */
  reusedMaterial: boolean;
  /**
   * True when the public host moved and the server cert was re-signed for it.
   * The identity behind it is the same one — see {@link reusedMaterial}.
   */
  reissuedServerCert: boolean;
  /** Whether the daemon's port answered before the timeout. */
  listening: boolean;
  /** What became of each managed Harness during the offer round. */
  agents: HarnessInstallOutcome[];
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
 */
async function resolveMaterial(
  opts: SetupOptions,
): Promise<{ material: PersistedMaterial; reused: boolean; reissued: boolean }> {
  const existing = loadMaterial(opts.layout.configDir);
  if (!existing) {
    return { material: await mintFreshMaterial(opts.publicHost), reused: false, reissued: false };
  }

  const previous = readActanaConfig(opts.layout.configDir);
  const material =
    existing.serverHost === "" && previous
      ? { ...existing, serverHost: previous.publicHost }
      : existing;
  if (serverCertCoversHost(material, opts.publicHost)) {
    return { material, reused: true, reissued: false };
  }

  opts.out(
    `Public host changed to ${opts.publicHost} — re-issuing this Core's server ` +
      "certificate from its own CA.",
  );
  return {
    material: await reissueServerCert(material, opts.publicHost),
    reused: true,
    reissued: true,
  };
}

/** Install, register, start, and pair this machine. */
export async function runActanaSetup(opts: SetupOptions): Promise<SetupResult> {
  const { layout, manifest, service } = opts;

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
  const replacingTree = source !== realpathOrNull(installDir);

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
  if (replacingTree && service.isActive()) {
    opts.out("Stopping the running Core before upgrading it…");
    service.stop();
  }

  if (replacingTree) installTree(source, installDir);
  pointSymlink(layout.currentLink, installDir);
  pointSymlink(layout.binLink, path.join(layout.currentLink, "bin", "actana"));
  fs.mkdirSync(layout.dataDir, { recursive: true });

  const { material, reused, reissued } = await resolveMaterial(opts);
  persistMaterial(layout.configDir, material);

  const config = {
    version: manifest.version,
    port: opts.port,
    host: opts.host,
    publicHost: opts.publicHost,
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
      AC_CORE_PUBLIC_HOST: opts.publicHost,
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

  return {
    blob: encodeRegistrationBlob({
      endpoint: endpointFor(config),
      label: opts.label,
      caCert: material.caCert,
      clientCert: material.clientCert,
      clientKey: material.clientKey,
      bearer,
    }),
    installDir,
    servicePath: service.filePath,
    serviceName: service.name,
    serviceSummary: persistence.summary,
    survivesLogout: persistence.survivesLogout,
    reusedMaterial: reused,
    reissuedServerCert: reissued,
    listening,
    agents,
  };
}
