// `actana update` — fetch a release, prove it is the release, swap it in.
//
// The order of operations is the whole design. Everything that can fail —
// resolving the version, downloading, verifying the checksum, unpacking,
// checking the build is for this machine — happens in a temporary directory,
// before a single byte of the running install is touched. Only once a verified,
// well-formed tree exists does the swap happen, and the swap itself is one
// symlink rename: `current` names the old version or the new one and never
// anything in between.
//
// So a failed update is a no-op, not a broken Core. That is the property the
// acceptance criterion "failed checksum aborts leaving the old install
// untouched" names, and it is why nothing here writes outside `workDir` until
// {@link verifyAndUnpack} has returned.
//
// Old versions are deliberately left in `versions/` rather than pruned: a
// Panel↔Core version lock is recovered by `actana update --version <older>`,
// and having the tree already on disk is the difference between that being a
// re-download and a repointed symlink.
//
// What survives an update: the pairing material (untouched — a paired Panel
// stays paired), the data dir, and every choice `actana setup` recorded. What
// changes: the tree, `current`, and the version in `actana.json`. The service
// definition is not rewritten because it already runs `current/bin/actana`.
//
// The one service this *does* rewrite is a pre-rename one. `current/bin/actana`
// is what the old agent runs too, so an update hands the new binary to a
// service that has been gone from the product for two renames, with the old
// environment still set on it (#348). It is removed here, before the restart —
// but only when this machine has a current service to take over from it. An
// update never leaves a machine with no auto-start service at all.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeActanaConfig, type ActanaConfig } from "./actana-config.ts";
import { installDirFor, type ActanaLayout } from "./actana-layout.ts";
import type { CoreManifest } from "./actana-manifest.ts";
import {
  lineOf,
  releaseTargetFor,
  resolveReleaseVersion,
  type ReleaseChannel,
  type ReleaseFetcher,
} from "./actana-release.ts";
import { isNewerSemver, isPrereleaseVersion } from "@actana/shared/semver";
import { fetchVerifiedRelease } from "./actana-fetch-release.ts";
import type { ActanaServiceManager } from "./actana-service.ts";
import type { ActanaSystem } from "./actana-system.ts";
import { installTree, missingTreeFile, pointSymlink, realpathOrNull } from "./actana-tree.ts";
import { claimLauncher } from "./actana-launcher.ts";

/** How long an update waits for the restarted daemon's port before saying so. */
const LISTEN_TIMEOUT_MS = 30_000;

export type UpdateOptions = {
  layout: ActanaLayout;
  /** The `PATH` this run was given, for deciding who owns the launcher. */
  env: NodeJS.ProcessEnv;
  /** What `actana setup` recorded — the version being replaced, and the port. */
  config: ActanaConfig;
  /** This machine's init system, for the restart onto the new tree. */
  service: ActanaServiceManager;
  system: ActanaSystem;
  fetcher: ReleaseFetcher;
  channel: ReleaseChannel;
  /** The version the operator pinned; the latest release when absent. */
  requestedVersion?: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Progress for the operator. */
  out: (line: string) => void;
};

export type UpdateResult = {
  /** False when the machine was already running the version asked for. */
  updated: boolean;
  /** The version `current` now points at. */
  version: string;
  /** The version it pointed at before. */
  previousVersion: string;
  installDir: string;
  /**
   * Whether the daemon's port answered after the restart.
   *
   * Null when nothing was restarted — an update that changed nothing, and the
   * machine with no current service to restart onto (#348), where a port that
   * answered would be somebody else's daemon.
   */
  listening: boolean | null;
};

/** Fetch, verify, and swap in a release, then restart the daemon onto it. */
export async function runActanaUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const { layout, config, service } = opts;

  // An Intel Mac lands here, and it is the one machine with a real answer
  // rather than a refusal — the on-device install is Apple silicon only, and
  // the container image is the supported path. Same distinction `install.sh`
  // draws at detection.
  const target = releaseTargetFor(opts.platform, opts.arch);
  if (!target) {
    throw new Error(
      opts.platform === "darwin" && opts.arch === "x64"
        ? "there is no Core build for an Intel Mac — the on-device install is Apple silicon " +
          "only. Run your Core from the container image instead."
        : `there is no Core build for ${opts.platform}/${opts.arch} — Cores run on Linux ` +
          "(WSL counts as Linux) at x64 and arm64, and on Apple-silicon macOS.",
    );
  }

  const version = await resolveReleaseVersion(opts.fetcher, opts.channel, opts.requestedVersion);

  // The downgrade guard (#322). A bare update resolves `/releases/latest`,
  // which excludes prereleases, so a machine installed from `0.4.1-beta` is
  // answered with `0.4.0` — an older version, and one the already-current
  // guard below waves straight through because the two strings simply differ.
  // What followed was a stop, a tree swap and a restart, reported to the
  // operator as an update.
  //
  // Nothing is changed and nothing is downloaded: the refusal is a sentence on
  // stdout and `updated: false`, which is the same shape "already current"
  // returns and which `actana update` renders as exit 0. Silence was the other
  // option and is worse — an operator who ran `update` is owed the reason it
  // did nothing.
  //
  // An explicit `--version` is never second-guessed. Pinning an older version
  // is how a Panel↔Core version lock is recovered, and an operator who named
  // one has already made this decision.
  if (!opts.requestedVersion && isNewerSemver(config.version, version)) {
    opts.out(refusedDowngrade(config.version, version));
    return {
      updated: false,
      version: config.version,
      previousVersion: config.version,
      installDir: config.installDir,
      listening: null,
    };
  }

  const installDir = installDirFor(layout, version);

  // "Already current" is about the tree, not just the recorded version: an
  // install whose `versions/<v>` has been deleted reports that version and
  // cannot start, and re-running update is the obvious repair.
  if (version === config.version && missingTreeFile(installDir) === null) {
    opts.out(`Already running Core ${version} — nothing to update.`);
    return {
      updated: false,
      version,
      previousVersion: config.version,
      installDir: config.installDir,
      listening: null,
    };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-update-work-"));
  let root: string;
  let manifest: CoreManifest;
  try {
    ({ root, manifest } = await fetchVerifiedRelease(
      {
        ...opts,
        noChange: "Nothing was changed; the Core is still running the version it was. Retry the update",
      },
      version,
      target,
      workDir,
    ));

    // Everything above this line was reversible. From here the install changes.
    //
    // Only a re-install of the *running* version has to stop the daemon first:
    // its tree is about to be replaced under it, and a process executing a
    // version that no longer exists on disk is a worse state than a short
    // outage. A normal update lands beside the running tree and needs no stop —
    // the restart below is the only interruption.
    if (realpathOrNull(installDir) && realpathOrNull(installDir) === realpathOrNull(layout.currentLink)) {
      service.stop();
    }
    installTree(root, installDir);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  // The atomic swap: after this rename the machine is running the new version.
  pointSymlink(layout.currentLink, installDir);
  // Same ownership rule setup follows (#288 D10): the launcher is repointed
  // when it is this install's, and left alone when it is somebody else's.
  // An update is if anything the more important of the two — an operator who
  // updates a Core has not asked for their `PATH` to be rearranged.
  const launcher = claimLauncher(layout, opts.env);
  if (launcher.note) opts.out(launcher.note);
  writeActanaConfig(layout.configDir, { ...config, version: manifest.version, installDir });

  // **Only when there is a current service to take over.** Removing the
  // pre-rename one is right on a machine that has both — it runs
  // `current/bin/actana` too, so the swap above has just handed it the new
  // tree, and `KeepAlive` restarts it into a race for the port. But on a
  // machine that has *only* the legacy service — which is the machine #348
  // describes, since `actana setup` was never run after the rename — removing
  // it leaves nothing to restart, and an update must never end with a machine
  // that has no auto-start service at all. There it is left alone and named,
  // and `actana setup` is the step that replaces it.
  // Asked of the init system rather than of the filesystem: `observe()` is
  // what knows whether this machine's *current* service exists, on both
  // platforms, and it is the same answer `actana status` renders.
  const observed = service.observe();
  const hasCurrentService = observed.name === service.name;
  if (hasCurrentService) {
    const legacy = service.removeLegacyUnit();
    if (legacy) opts.out(`Removed ${legacy}, left by an install from before the rename.`);
  }

  if (!hasCurrentService) {
    // Not an error, and not a restart either: the tree is placed and `current`
    // points at it, but nothing on this machine is registered to run it. The
    // old `verb("restart")` here bootstrapped a plist that does not exist,
    // failed, and pointed the operator at the logs of a daemon that was never
    // started.
    const legacy = observed.legacyName;
    opts.out(
      legacy
        ? `${manifest.version} is installed, and nothing was restarted: this machine's only ` +
            `auto-start service is ${legacy}, left by an install from before the rename. It ` +
            "is still in place — removing it would leave no service at all. `actana setup` " +
            "replaces it with this Core's own and starts the daemon."
        : `${manifest.version} is installed, and nothing was restarted: this machine has no ` +
            `auto-start service. \`actana setup\` registers ${service.name} and starts the daemon.`,
    );
    return {
      updated: true,
      version: manifest.version,
      previousVersion: config.version,
      installDir,
      // Not probed: nothing was asked to start, so a port that answers would
      // be somebody else's daemon and a port that does not is not news.
      listening: null,
    };
  }

  opts.out(`Restarting ${service.name} on ${manifest.version}…`);
  const restarted = service.verb("restart");
  if (restarted.status !== 0) {
    throw new Error(
      `${manifest.version} is installed but ${service.name} would not restart: ` +
        `${(restarted.stderr || restarted.stdout).trim() || `exit ${restarted.status}`}. ` +
        "Check `actana logs`.",
    );
  }

  return {
    updated: true,
    version: manifest.version,
    previousVersion: config.version,
    installDir,
    listening: await opts.system.waitForPort(config.port, LISTEN_TIMEOUT_MS),
  };
}

/**
 * What the operator is told when a bare update would move them backwards.
 *
 * The prerelease case gets its own opening sentence because it is the one an
 * operator has no other way to make sense of: they installed a beta on
 * purpose, ran `update`, and it did nothing. Naming the line — `0.4.1-beta` is
 * the beta of the 0.4.1 line (ADR 0036 D1, D2) — is what makes the next
 * sentence land, because the release they are waiting for is that line's, and
 * `actana update` will take it the day it exists.
 */
function refusedDowngrade(installed: string, resolved: string): string {
  const opening = isPrereleaseVersion(installed)
    ? `This Core is on ${installed}, a prerelease of the ${lineOf(installed)} line, and the ` +
      `newest release is ${resolved} — older than what is installed.`
    : `This Core is on ${installed} and the newest release is ${resolved} — older than what ` +
      "is installed.";
  return [
    `${opening} Nothing was changed: updating would move this machine backwards.`,
    isPrereleaseVersion(installed)
      ? `A bare \`actana update\` will move this Core as soon as ${lineOf(installed)} is ` +
        "released."
      : "A bare `actana update` will move this Core again as soon as a newer release exists.",
    `To install ${resolved} anyway, pin it: \`actana update --version ${resolved}\`.`,
  ].join(" ");
}
