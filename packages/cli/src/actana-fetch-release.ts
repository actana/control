// Fetch a release, prove it is the release, unpack it — and touch nothing else.
//
// The half of `actana update` that `actana install` needs too (#288 D8).
// Everything that can fail — resolving the checksums, downloading, verifying
// the digest, unpacking, checking the build is for this machine — happens
// inside a caller-supplied `workDir`, and this module writes nowhere else.
// That is what lets both callers claim the same property:
//
//   **a failed fetch is a no-op.** `update` says "the Core is still running the
//   version it was"; `install` says "nothing was installed". Neither is a
//   promise about careful error handling — it is a fact about which directories
//   this function is allowed to write to, and `install`'s wrong-checksum test
//   is what holds it.
//
// The CLI is now a second front door onto this work. `install.sh` is the first
// and it stays exactly as it is: a bare machine has no Node and the tarball
// carries its own pinned one, so the shell script cannot be replaced by the CLI
// it installs. Two doors, one implementation of the real work — which is the
// argument `install.sh`'s own header already makes for why it stays thin.

import * as fs from "node:fs";
import * as path from "node:path";
import { readCoreManifest, type CoreManifest } from "./actana-manifest.ts";
import {
  SHASUMS_ASSET,
  assetUrl,
  parseShasums,
  releaseAssetName,
  sha256OfFile,
  type ReleaseChannel,
  type ReleaseFetcher,
} from "./actana-release.ts";
import type { ActanaSystem } from "./actana-system.ts";
import { missingTreeFile } from "./actana-tree.ts";

/** What fetching a release needs — a subset of both callers' own options. */
export type FetchReleaseOptions = {
  fetcher: ReleaseFetcher;
  channel: ReleaseChannel;
  /** Only `tar` is ever run through it. */
  system: ActanaSystem;
  platform: NodeJS.Platform;
  arch: string;
  /** Progress for the operator. */
  out: (line: string) => void;
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
export async function fetchVerifiedRelease(
  opts: FetchReleaseOptions,
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
