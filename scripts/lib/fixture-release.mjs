// A local stand-in for GitHub Releases.
//
// `install.sh` and (later) `actana update` fetch a release the same way an
// operator's machine does: ask for a tag, download a tarball and `SHA256SUMS`,
// verify one against the other. Pointing that at github.com in a test would
// make CI depend on a published release existing and on the network being up —
// so this server speaks the two shapes the installer needs, over http, against
// tarballs built moments earlier on the same machine:
//
//   GET /repos/<owner>/<repo>/releases/latest      → release JSON
//   GET /repos/<owner>/<repo>/releases/tags/<tag>  → release JSON
//   GET /<owner>/<repo>/releases/download/<tag>/<asset>
//   GET /install.sh                                → the bootstrapper itself
//
// The releases it serves are whatever tarballs are in a directory: the file
// names carry version and target, so a directory holding two versions is a
// two-release fixture with no manifest to keep in sync. `SHA256SUMS` is
// computed from the bytes on disk rather than written by hand, which is what
// makes `corruptAssets` a real integrity failure — the digest stays honest and
// the body does not match it.
//
// The routing and indexing above the transport is pure and covered by
// `scripts/__tests__/fixture-release.test.mjs`.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

import { formatShasums, tarballName, tarballRootDirName } from "./harness-tarball.mjs";

/** The repository the installer defaults to — also this fixture's default. */
export const DEFAULT_REPO = "actana/control";

/** The checksum asset every release carries, named as the release workflow names it. */
export const SHASUMS_ASSET = "SHA256SUMS";

const ASSET_PATTERN = /^actana-harness-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-([a-z0-9]+-[a-z0-9]+)\.tar\.gz$/;

/**
 * Split a release tarball's name back into `{ version, target }`, or null when
 * the name is not one of ours. The inverse of `tarballName`, which the unit
 * test pins by round-tripping the two.
 */
export function parseAssetName(name) {
  const match = ASSET_PATTERN.exec(name);
  return match ? { version: match[1], target: match[2] } : null;
}

/**
 * Order two versions the way a release channel does: numerically by component,
 * with a prerelease sorting *before* the release it leads to (`1.0.0-rc.1` <
 * `1.0.0`). Enough of semver to pick a latest; not a semver implementation.
 */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, prerelease] = v.split("-", 2);
    return { parts: core.split(".").map(Number), prerelease };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * Group release tarball names by version.
 *
 * Returns `[{ version, assets: Map<target, name> }]` ordered oldest first, so
 * the last entry is what `releases/latest` answers with. Names that are not
 * release tarballs (a stray `SHA256SUMS`, an editor's backup file) are ignored
 * rather than rejected — the directory is a build output dir, not a manifest.
 */
export function indexReleases(fileNames) {
  const byVersion = new Map();
  for (const name of fileNames) {
    const parsed = parseAssetName(name);
    if (!parsed) continue;
    if (!byVersion.has(parsed.version)) byVersion.set(parsed.version, new Map());
    byVersion.get(parsed.version).set(parsed.target, name);
  }
  return [...byVersion.entries()]
    .sort(([a], [b]) => compareVersions(a, b))
    .map(([version, assets]) => ({ version, assets }));
}

/**
 * Resolve a request path against the repo this fixture stands in for.
 *
 * Kept apart from the server so every route — including the ones a broken
 * `install.sh` would ask for — can be asserted without sockets.
 */
export function routeFixtureRequest(pathname, repo) {
  if (pathname === "/install.sh") return { kind: "script" };

  const api = new RegExp(`^/repos/${escapeRegExp(repo)}/releases/(latest|tags/([^/]+))$`).exec(pathname);
  if (api) return api[1] === "latest" ? { kind: "latest" } : { kind: "tag", tag: decodeURIComponent(api[2]) };

  const download = new RegExp(
    `^/${escapeRegExp(repo)}/releases/download/([^/]+)/([^/]+)$`,
  ).exec(pathname);
  if (download) {
    return {
      kind: "asset",
      tag: decodeURIComponent(download[1]),
      asset: decodeURIComponent(download[2]),
    };
  }

  return { kind: "not-found" };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The subset of GitHub's release JSON the installer reads.
 *
 * `tag_name` is the field `install.sh` greps for; the asset list is there
 * because it is what a real response carries, and a fixture that answers with
 * less would let the installer start depending on that.
 */
export function releaseJson({ repo, version, assets, baseUrl }) {
  const tag = `v${version}`;
  const names = [...assets.values(), SHASUMS_ASSET].sort();
  return {
    tag_name: tag,
    name: tag,
    draft: false,
    prerelease: version.includes("-"),
    assets: names.map((name) => ({
      name,
      browser_download_url: `${baseUrl}/${repo}/releases/download/${tag}/${name}`,
    })),
  };
}

/**
 * Serve `dir`'s tarballs as if they were GitHub Releases.
 *
 * `corruptAssets` names assets whose body is served with one byte flipped:
 * the checksum stays truthful, so the installer sees exactly what a corrupted
 * or tampered download looks like. `requests` records every path served, which
 * is how a test asserts that an installer aborted *before* fetching a tarball.
 *
 * Returns once the socket is listening.
 */
export async function startFixtureReleaseServer({
  dir,
  repo = DEFAULT_REPO,
  host = "127.0.0.1",
  port = 0,
  scriptPath,
  corruptAssets = [],
} = {}) {
  const releaseDir = path.resolve(dir);
  if (!fs.existsSync(releaseDir)) throw new Error(`no such release directory: ${releaseDir}`);
  const corrupt = new Set(corruptAssets);
  const requests = [];

  const releases = () => indexReleases(fs.readdirSync(releaseDir));
  const findRelease = (tag) => releases().find((r) => `v${r.version}` === tag);

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, `http://${host}`).pathname;
    requests.push(pathname);

    const send = (status, body, contentType) => {
      res.writeHead(status, {
        "content-type": contentType,
        "content-length": Buffer.byteLength(body),
      });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const notFound = (what) => send(404, `${what} not found\n`, "text/plain");

    const route = routeFixtureRequest(pathname, repo);
    const baseUrl = `http://${host}:${server.address().port}`;

    if (route.kind === "script") {
      if (!scriptPath) return notFound("install.sh");
      return send(200, fs.readFileSync(scriptPath), "text/x-shellscript");
    }

    if (route.kind === "latest" || route.kind === "tag") {
      const all = releases();
      const release = route.kind === "latest" ? all[all.length - 1] : findRelease(route.tag);
      if (!release) return notFound("release");
      const body = JSON.stringify(
        releaseJson({ repo, version: release.version, assets: release.assets, baseUrl }),
        null,
        2,
      );
      return send(200, body, "application/json");
    }

    if (route.kind === "asset") {
      const release = findRelease(route.tag);
      if (!release) return notFound("release");

      if (route.asset === SHASUMS_ASSET) {
        return send(200, shasumsFor(releaseDir, release), "text/plain");
      }
      if (![...release.assets.values()].includes(route.asset)) return notFound("asset");

      const bytes = fs.readFileSync(path.join(releaseDir, route.asset));
      if (corrupt.has(route.asset)) bytes[0] ^= 0xff;
      return send(200, bytes, "application/gzip");
    }

    return notFound("path");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    repo,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The `SHA256SUMS` for one release, digested from the files on disk. */
function shasumsFor(releaseDir, release) {
  const entries = new Map();
  for (const name of release.assets.values()) {
    const digest = createHash("sha256").update(fs.readFileSync(path.join(releaseDir, name))).digest("hex");
    entries.set(name, digest);
  }
  return formatShasums(entries);
}

/**
 * Repack a tarball under a different version.
 *
 * The manifest version is what `actana setup` installs by, what `status`
 * reports, and what `actana update` resolves against — so bumping it produces a
 * genuinely different release from the same verified bytes. That is enough to
 * tell `--version` from "latest", and to give `update` something newer to land,
 * without a second twenty-minute build.
 */
export function repackWithVersion(tarball, version, workDir, fail) {
  const die = fail ?? ((message) => { throw new Error(message); });
  const parsed = parseAssetName(path.basename(tarball));
  if (!parsed) die(`${path.basename(tarball)} is not a Harness release tarball`);

  const stageDir = path.join(workDir, `repack-${version}`);
  fs.mkdirSync(stageDir, { recursive: true });
  const extract = spawnSync("tar", ["-xzf", tarball, "-C", stageDir], { encoding: "utf8" });
  if (extract.status !== 0) die(`could not unpack ${tarball}: ${extract.stderr}`);

  const oldRoot = path.join(stageDir, tarballRootDirName(parsed.version, parsed.target));
  const newRoot = path.join(stageDir, tarballRootDirName(version, parsed.target));
  fs.renameSync(oldRoot, newRoot);

  const manifestPath = path.join(newRoot, "harness-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + "\n");

  const outPath = path.join(path.dirname(tarball), tarballName(version, parsed.target));
  const pack = spawnSync("tar", ["-czf", outPath, "-C", stageDir, path.basename(newRoot)], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (pack.status !== 0) die(`could not repack ${outPath}: ${pack.stderr}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  return { path: outPath, version, target: parsed.target };
}

/** The next patch version after `version` — the "newer release" of a pair. */
export function bumpPatch(version) {
  const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Start the fixture release server in a child process.
 *
 * A child rather than an in-process server on purpose: the e2e tests drive
 * their machine with synchronous `docker exec` / `spawnSync` calls, and an
 * in-process server could not answer a download while one of those is blocking
 * the event loop. The machine would hang on the fetch, not fail.
 */
export async function startFixtureServerProcess({ dir, port, host = "0.0.0.0", corrupt = [], die }) {
  const argv = [
    path.join(import.meta.dirname, "..", "fixture-release-server.mjs"),
    "--dir",
    dir,
    "--port",
    String(port),
    "--host",
    host,
  ];
  if (corrupt.length > 0) argv.push("--corrupt", corrupt.join(","));

  const child = spawn(process.execPath, argv, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) die(`fixture release server exited ${code}`);
  });
  process.on("exit", () => child.kill("SIGKILL"));

  await waitForFixturePort(port, die);
  return { port, stop: () => child.kill("SIGTERM") };
}

/** Wait until something accepts connections on `port`, or give up. */
async function waitForFixturePort(port, die, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      const finish = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(1_000);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
    if (open) return;
    if (Date.now() >= deadline) die(`the fixture release server never listened on ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Write a stand-in release tarball: a tree the installer can verify, extract
 * and exec, with a `bin/actana` that records what it was called with instead of
 * installing anything.
 *
 * The tests that use this are about the *bootstrapper* — platform mapping,
 * checksums, version resolution, flag passthrough. Building a real Harness for
 * them would take minutes and prove nothing extra; the container e2e is where
 * the real tarball runs.
 */
export function writeStubRelease({ dir, version, target, script }) {
  fs.mkdirSync(dir, { recursive: true });
  const rootName = `actana-harness-${version}-${target}`;
  const stageDir = path.join(dir, `.stage-${rootName}`);
  const binDir = path.join(stageDir, rootName, "bin");
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(binDir, { recursive: true });

  fs.writeFileSync(
    path.join(stageDir, rootName, "harness-manifest.json"),
    JSON.stringify({ name: "actana-harness", version, target }, null, 2) + "\n",
  );
  const actana = path.join(binDir, "actana");
  fs.writeFileSync(actana, script);
  fs.chmodSync(actana, 0o755);

  const outPath = path.join(dir, tarballName(version, target));
  const result = spawnSync("tar",["-czf", outPath, "-C", stageDir, rootName], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr || result.status}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  return outPath;
}
