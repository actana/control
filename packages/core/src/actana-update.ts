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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeActanaConfig, type ActanaConfig } from "./actana-config";
import { installDirFor, type ActanaLayout } from "./actana-layout";
import { readCoreManifest, type CoreManifest } from "./actana-manifest";
import {
  SHASUMS_ASSET,
  assetUrl,
  parseShasums,
  releaseAssetName,
  releaseTargetFor,
  resolveReleaseVersion,
  sha256OfFile,
  type ReleaseChannel,
  type ReleaseFetcher,
} from "./actana-release";
import type { ActanaServiceManager } from "./actana-service";
import type { ActanaSystem } from "./actana-system";
import { installTree, missingTreeFile, pointSymlink, realpathOrNull } from "./actana-tree";

/** How long an update waits for the restarted daemon's port before saying so. */
const LISTEN_TIMEOUT_MS = 30_000;

export type UpdateOptions = {
  layout: ActanaLayout;
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
  /** Whether the daemon's port answered after the restart; null when nothing changed. */
  listening: boolean | null;
};

/**
 * Download the release and return the verified, unpacked tree inside `workDir`.
 *
 * Checksums are fetched first: `SHA256SUMS` names every asset in the release,
 * so it answers both "does this release exist" and "does it have a build for
 * me" before a tarball is downloaded. Failing on the digest before unpacking is
 * what keeps a tampered or truncated archive from ever being written anywhere
 * the daemon could run it from.
 */
async function verifyAndUnpack(
  opts: UpdateOptions,
  version: string,
  target: string,
  workDir: string,
): Promise<{ root: string; manifest: CoreManifest }> {
  const asset = releaseAssetName(version, target);
  const sumsUrl = assetUrl(opts.channel, version, SHASUMS_ASSET);

  let sumsText: string;
  try {
    sumsText = await opts.fetcher.fetchText(sumsUrl);
  } catch (err) {
    throw new Error(
      `could not fetch ${sumsUrl}: ${message(err)}. Either there is no release v${version}, ` +
        "or this machine cannot reach the release channel.",
    );
  }

  const expected = parseShasums(sumsText).get(asset);
  if (!expected) {
    throw new Error(
      `release v${version} has no build for ${target} — its ${SHASUMS_ASSET} does not list ${asset}.`,
    );
  }

  opts.out(`Downloading ${asset}…`);
  const tarball = path.join(workDir, asset);
  const downloadUrl = assetUrl(opts.channel, version, asset);
  try {
    await opts.fetcher.download(downloadUrl, tarball);
  } catch (err) {
    throw new Error(`could not download ${downloadUrl}: ${message(err)}`);
  }

  const actual = sha256OfFile(tarball);
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${asset} — refusing to install it.\n` +
        `  expected ${expected}\n` +
        `  actual   ${actual}\n` +
        "Nothing was changed; the Core is still running the version it was. Retry the " +
        "update, and if it keeps failing the release assets or the connection to them " +
        "cannot be trusted.",
    );
  }
  // What this proves: the tarball is the one the release's own checksum file
  // describes. Both came over the same channel, so it catches corruption and
  // truncation, not a release channel someone else controls — the project
  // publishes no signatures (spec: "No code signing").
  opts.out(`Checksum verified against the release's ${SHASUMS_ASSET}.`);

  const extracted = opts.system.run("tar", ["-xzf", tarball, "-C", workDir]);
  if (extracted.status !== 0) {
    throw new Error(`could not unpack ${asset}: ${(extracted.stderr || extracted.stdout).trim()}`);
  }

  const root = path.join(workDir, `actana-core-${version}-${target}`);
  if (!fs.existsSync(root)) {
    throw new Error(`${asset} does not contain actana-core-${version}-${target} — the release asset looks wrong.`);
  }
  const missing = missingTreeFile(root);
  if (missing) {
    throw new Error(`${asset} is not a complete Core build: no ${missing}.`);
  }

  const manifest = readCoreManifest(root);
  if (!manifest) throw new Error(`${asset} has no readable core-manifest.json.`);
  if (manifest.version !== version) {
    throw new Error(
      `${asset} was published as v${version} but its manifest says ${manifest.version} — ` +
        "refusing to install a release that does not describe itself.",
    );
  }
  if (manifest.platform !== opts.platform || manifest.arch !== opts.arch) {
    throw new Error(
      `${asset} is a ${manifest.target} build (${manifest.platform}/${manifest.arch}) but this ` +
        `machine is ${opts.platform}/${opts.arch}.`,
    );
  }
  return { root, manifest };
}

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
    ({ root, manifest } = await verifyAndUnpack(opts, version, target, workDir));

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
  pointSymlink(layout.binLink, path.join(layout.currentLink, "bin", "actana"));
  writeActanaConfig(layout.configDir, { ...config, version: manifest.version, installDir });

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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
