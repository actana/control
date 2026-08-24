#!/usr/bin/env node
// Compose the `SHA256SUMS` release asset covering the Core tarballs.
//
// Run after every per-platform build has uploaded its tarball into one
// directory. Emits `SHA256SUMS` alongside them in the format `sha256sum -c`
// (and `shasum -a 256 -c`) accept, so an operator can verify a download with
// the tool already on their machine — and `install.sh` / `actana update` can
// verify it with the same file.
//
// Every tarball in the directory has to belong to the same release: one
// version, one tarball per target. `SHA256SUMS` is an asset of a single
// Release, and a beta's assets and a release's are never confusable
// (ADR 0036 D20) — a checksum file listing `0.4.1-beta` beside `0.4.1` would
// be exactly that confusion, published under one name.
//
// Usage:
//   node scripts/compose-core-shasums.mjs --dir <dir> [--expect <n>]
//                                         [--version <v>]
//
// --dir     Directory holding the tarballs (searched one level deep, so
//           GitHub's per-artifact subdirectories work unflattened).
// --expect  Fail unless exactly this many tarballs were found. CI passes the
//           full target count (`CORE_TARGETS.length`, spelled out in
//           release.yml) so a silently missing platform is a red build, not a
//           checksum file that quietly covers two of three.
// --version Fail unless the tarballs are that version. Optional: the set is
//           already required to agree with itself, and this is for a caller
//           that knows which version it asked for — a beta cut naming
//           `x.y.z-beta` proves the assets it is about to publish are the
//           beta's rather than a stale release build left in the directory.

import * as fs from "node:fs";
import * as path from "node:path";

import { makeFail, parseArgs, stringFlag } from "./lib/cli.mjs";
import { digestFile } from "./lib/hash.mjs";
import { assertShasumsSet, formatShasums } from "./lib/core-tarball.mjs";

const fail = makeFail("core-shasums");
const log = (message) => console.log(`[core-shasums] ${message}`);

/** Tarball paths directly in `dir` or in any of its immediate subdirectories. */
function findTarballs(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".tar.gz")) {
      found.push(full);
    } else if (entry.isDirectory()) {
      for (const nested of fs.readdirSync(full, { withFileTypes: true })) {
        if (nested.isFile() && nested.name.endsWith(".tar.gz")) {
          found.push(path.join(full, nested.name));
        }
      }
    }
  }
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length > 0) fail(`unexpected argument: ${args._[0]}`);

  const dirFlag = stringFlag(args, "dir", fail);
  if (!dirFlag) fail("--dir is required");
  const dir = path.resolve(dirFlag);
  if (!fs.existsSync(dir)) fail(`no such directory: ${dir}`);

  const tarballs = findTarballs(dir);
  if (tarballs.length === 0) fail(`no *.tar.gz found under ${dir}`);

  const expectFlag = stringFlag(args, "expect", fail);
  if (expectFlag !== undefined) {
    const expected = Number(expectFlag);
    if (!Number.isInteger(expected) || expected < 1) fail(`bad --expect: ${expectFlag}`);
    if (tarballs.length !== expected) {
      fail(
        `expected ${expected} tarball(s), found ${tarballs.length}: ` +
          tarballs.map((t) => path.basename(t)).join(", "),
      );
    }
  }

  // One release's worth of tarballs, or nothing. This rejects a stray archive,
  // a second copy of a target, and — the case this file exists to refuse — a
  // directory holding two versions at once.
  let covered;
  try {
    covered = assertShasumsSet(tarballs.map((t) => path.basename(t)));
  } catch (err) {
    fail(`${err.message} (under ${dir})`);
  }

  const versionFlag = stringFlag(args, "version", fail);
  if (versionFlag !== undefined && versionFlag !== covered.version) {
    fail(`--version ${versionFlag} but the tarballs are ${covered.version}`);
  }

  const entries = new Map();
  for (const tarball of tarballs) {
    entries.set(path.basename(tarball), await digestFile(tarball, "sha256"));
  }

  // The checksum file sits next to the assets it covers, with bare basenames,
  // because that is where `sha256sum -c SHA256SUMS` expects to find them.
  const outPath = path.join(dir, "SHA256SUMS");
  fs.writeFileSync(outPath, formatShasums(entries));

  log(`wrote ${outPath} — ${covered.version}, covering ${covered.targets.join(", ")}`);
  for (const [name, digest] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
    log(`  ${digest}  ${name}`);
  }
}

void main().catch((err) => {
  fail(err.stack || err.message);
});
