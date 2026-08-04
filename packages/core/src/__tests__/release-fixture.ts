// A local stand-in for GitHub Releases, for the `actana update` tests.
//
// Real tarballs on disk, real `tar -czf`, real SHA-256 digests computed from
// the bytes served — so the checksum step under test is the checksum step that
// runs on an operator's machine, and `corrupt` is a genuine integrity failure
// rather than an arranged one. Only the transport is faked: a
// {@link ReleaseFetcher} that resolves URLs against a directory instead of a
// socket, which keeps these unit tests hermetic and instant.
//
// The container e2e (`scripts/e2e-install-sh-linux.mjs`) runs the same shapes
// over http against `scripts/fixture-release-server.mjs`; this is that server's
// in-process cousin, and the two must agree on the URL layout.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SHASUMS_ASSET,
  releaseAssetName,
  type ReleaseChannel,
  type ReleaseFetcher,
} from "../actana-release";

/** The manifest fields a release tarball carries at its root. */
export type FixtureManifest = {
  version: string;
  protocolVersion: string;
  target: string;
  platform: string;
  arch: string;
  nodeVersion: string;
};

/** Write the file tree a Core tarball contains, at `root`. */
export function writeTarballTree(root: string, manifest: FixtureManifest): void {
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "node", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "actana"), "#!/bin/sh\n");
  fs.chmodSync(path.join(root, "bin", "actana"), 0o755);
  fs.writeFileSync(path.join(root, "app", "core-entry.cjs"), `// daemon ${manifest.version}\n`);
  fs.writeFileSync(path.join(root, "node", "bin", "node"), "#!/bin/sh\n");
  fs.writeFileSync(
    path.join(root, "core-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

/**
 * Build a release tarball into `dir`, named as the release workflow names it.
 *
 * `manifest` overrides let a test publish a deliberately wrong release — a
 * mac build in a linux release, a manifest whose version does not match its
 * name — which is the only way to assert that `update` checks.
 */
export function writeRelease(opts: {
  dir: string;
  version: string;
  target: string;
  manifest?: Partial<FixtureManifest>;
  /** Files to leave out of the tree, e.g. `node/bin/node` for a broken build. */
  omit?: string[];
}): string {
  const { dir, version, target } = opts;
  const [platform, arch] = target.split("-");
  const manifest: FixtureManifest = {
    version,
    protocolVersion: "3",
    target,
    platform: platform === "mac" ? "darwin" : platform,
    arch,
    nodeVersion: "24.15.0",
    ...opts.manifest,
  };

  const stage = fs.mkdtempSync(path.join(dir, ".stage-"));
  const rootName = `actana-core-${version}-${target}`;
  const root = path.join(stage, rootName);
  writeTarballTree(root, manifest);
  for (const rel of opts.omit ?? []) fs.rmSync(path.join(root, rel), { force: true });

  const outPath = path.join(dir, releaseAssetName(version, target));
  const packed = spawnSync("tar", ["-czf", outPath, "-C", stage, rootName], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr || packed.status}`);
  fs.rmSync(stage, { recursive: true, force: true });
  return outPath;
}

/** Parse a release tarball's name back into its version and target. */
function parseAssetName(name: string): { version: string; target: string } | null {
  const match = /^actana-core-(.+)-([a-z0-9]+-[a-z0-9]+)\.tar\.gz$/.exec(name);
  return match ? { version: match[1], target: match[2] } : null;
}

/** Order two dotted versions numerically — enough of semver to pick a latest. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** A fetcher over a directory of release tarballs, plus what it was asked for. */
export type FixtureFetcher = ReleaseFetcher & { asked: string[] };

/**
 * Serve `dir`'s tarballs as `channel`'s releases.
 *
 * `corrupt` names assets whose bytes are delivered with one flipped — the
 * `SHA256SUMS` stays truthful, so the caller sees exactly what a corrupted or
 * tampered download looks like.
 */
export function fixtureFetcher(
  dir: string,
  channel: ReleaseChannel,
  opts: { corrupt?: string[] } = {},
): FixtureFetcher {
  const corrupt = new Set(opts.corrupt ?? []);
  const asked: string[] = [];

  const releases = (): Map<string, string[]> => {
    const byVersion = new Map<string, string[]>();
    for (const name of fs.readdirSync(dir)) {
      const parsed = parseAssetName(name);
      if (!parsed) continue;
      byVersion.set(parsed.version, [...(byVersion.get(parsed.version) ?? []), name]);
    }
    return byVersion;
  };

  const latestVersion = (): string | null =>
    [...releases().keys()].sort(compareVersions).pop() ?? null;

  /** `{version, asset}` for a download URL, or null when it is not one. */
  const assetRoute = (url: string): { version: string; asset: string } | null => {
    const prefix = `${channel.downloadBase}/${channel.repo}/releases/download/v`;
    if (!url.startsWith(prefix)) return null;
    const [version, asset] = url.slice(prefix.length).split("/");
    return version && asset ? { version, asset } : null;
  };

  const shasumsFor = (version: string): string => {
    const names = releases().get(version);
    if (!names) throw new Error(`404 no release v${version}`);
    return names
      .sort()
      .map(
        (name) =>
          `${createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex")}  ${name}`,
      )
      .join("\n") + "\n";
  };

  return {
    asked,
    async fetchText(url) {
      asked.push(url);
      if (url === `${channel.apiBase}/repos/${channel.repo}/releases/latest`) {
        const version = latestVersion();
        if (!version) throw new Error("404 no releases");
        return JSON.stringify({ tag_name: `v${version}` });
      }
      const route = assetRoute(url);
      if (route?.asset === SHASUMS_ASSET) return shasumsFor(route.version);
      throw new Error(`404 ${url}`);
    },
    async download(url, destPath) {
      asked.push(url);
      const route = assetRoute(url);
      if (!route) throw new Error(`404 ${url}`);
      const source = path.join(dir, route.asset);
      if (!releases().get(route.version)?.includes(route.asset) || !fs.existsSync(source)) {
        throw new Error(`404 ${url}`);
      }
      const bytes = fs.readFileSync(source);
      if (corrupt.has(route.asset)) bytes[0] ^= 0xff;
      fs.writeFileSync(destPath, bytes);
    },
  };
}
