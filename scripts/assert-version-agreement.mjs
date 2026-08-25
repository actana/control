#!/usr/bin/env node
// `pnpm versions:assert` — does the version string on this surface agree with
// the tree it claims to describe? (ADR 0037 D3.)
//
// This is the one check in the repository that reads content rather than a
// name. Everything else in the version chain derives a string from another
// string: the image tag from the branch name, the release version from the tag
// name, the tarball's filename and archive root and `core-manifest.json` from
// `RELEASE_VERSION`. Those comparisons are tautologies — they can all pass
// while the six manifests inside the bytes say something else entirely.
//
// So every writer of a version string runs this against the tree it is about,
// **before** it writes:
//
//   ci.yml       Train versions   on every push to a train, before the image
//                                 tags are resolved and the images published
//   promote.yml  resolve          before the fast-forward and before the tag
//   release.yml  resolve          at the tag, before any tarball or image
//
// and a beta cut runs it the same way, with `--expected vx.y.z-beta` — the
// manifests carry the line, so the beta and the release of a line are checked
// against exactly the same six numbers (ADR 0036 D1, C1).
//
// Usage:
//
//   node scripts/assert-version-agreement.mjs --expected 0.4.1 \
//     --source "the train branch beta/0.4.1"
//   node scripts/assert-version-agreement.mjs --expected v0.4.1-beta \
//     --git-ref "$sha" --source "the tag v0.4.1-beta"
//
// and an image is checked the same way, with the label read off the pulled
// bytes instead of the manifests read off a tree:
//
//   node scripts/assert-version-agreement.mjs --expected 0.4.1 \
//     --image-label "$label" --source "actana/core:beta-0.4.1 at linux/amd64"
//
// `--expected` takes any of the shapes a surface writes — `0.4.1`, `v0.4.1`,
// `0.4.1-beta`, `v0.4.1-beta` — and the leading `v` is stripped, because the
// callers hand it whatever their own surface calls the thing.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MANIFESTS,
  checkAgreement,
  imageVersionProblem,
  lineOf,
  readInstallerStamp,
  readManifestVersions,
  stripTagPrefix,
  versionProblem,
} from "./lib/version-agreement.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const onGitHub = Boolean(process.env.GITHUB_ACTIONS);

function parseArgs(argv) {
  const options = {
    expected: null,
    source: null,
    gitRef: null,
    root: repoRoot,
    imageLabel: null,
    requireStamp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error(`${arg} needs a value`);
        process.exit(2);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--expected":
        options.expected = take();
        break;
      case "--source":
        options.source = take();
        break;
      case "--git-ref":
        options.gitRef = take();
        break;
      case "--image-label":
        options.imageLabel = take();
        break;
      case "--require-stamp":
        options.requireStamp = true;
        break;
      case "--root":
        options.root = path.resolve(take());
        break;
      default:
        console.error(`unknown argument '${arg}'`);
        process.exit(2);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.expected) {
  console.error("--expected is required — the version string the surface being checked writes");
  process.exit(2);
}

// `v0.4.1` and `0.4.1` are the same fact under two names, and which one a
// caller has depends on whether it is holding a tag or a branch. Normalising
// here is what lets every caller pass its own surface's spelling — and it is
// done unconditionally rather than only for strings that parse, so that
// `v0.4.1-beta.1` is reported as the counted beta it is rather than as an
// unrecognisable string.
const expected = stripTagPrefix(options.expected);
const source = options.source ?? "the version handed to this check";

// The image mode. An image is the one surface whose claim about itself lives
// in the bytes rather than in a file this process can open, so the caller
// reads `org.opencontainers.image.version` off the pulled image and hands it
// here — the comparison is the same one, against the same line.
if (options.imageLabel !== null) {
  const problem = imageVersionProblem({ label: options.imageLabel, expected });
  if (!problem) {
    console.log(`✅ ${source} self-reports ${lineOf(expected)}, the line being published as ${expected}.`);
    process.exit(0);
  }
  // Two different failures reach this line and a person reading the annotation
  // has to be able to tell them apart: the bytes disagree with the tag, or the
  // tag is not a string this repository may publish at all. `0.4.1-beta.1` is
  // the second — and headlining it as an image that does not self-report would
  // send the reader to rebuild an image whose label is fine (ADR 0036 C1).
  const shape = versionProblem(expected);
  const title = shape
    ? "Not a version this repository writes"
    : "The image does not self-report the version being published";
  // The same sentence `checkAgreement` builds for a bad string on a tree, so
  // one bad version reads the same wherever it is caught.
  const detail = shape
    ? `\`${expected}\` cannot be published: ${shape}. It is what ${source} would be published as.`
    : `${source} would be published as ${expected}, and ${problem} (ADR 0037 D4).`;
  if (onGitHub) console.log(`::error title=${title}::${detail}`);
  console.error(`❌ ${detail}`);
  process.exit(1);
}

const versions = readManifestVersions({ root: options.root, gitRef: options.gitRef });
// The installer's stamp is checked wherever it exists and required only where a
// caller says it must (ADR 0036 D4). A tree from before the stamp landed is a
// real thing to run this against — an old tag re-released — and refusing it
// there would be refusing history; a train cut without one is the failure.
const stamp = readInstallerStamp({ root: options.root, gitRef: options.gitRef });
const { line, problems } = checkAgreement({
  expected,
  versions,
  stamp,
  stampRequired: options.requireStamp,
});

const where = options.gitRef ? `at ${options.gitRef}` : "in the working tree";
console.log(
  `Asserting ${MANIFESTS.length} manifests${options.requireStamp ? " and the installer's line stamp" : ""} ` +
    `${where} against ${expected}, from ${source}.`,
);

// Two failures must not be dressed up as six drifting manifests. A bad version
// string is one problem with the string, and a ref this clone does not have is
// one problem with the ref; the per-file listing below is only meaningful when
// there is a line to compare against and a tree that answered.
const unreadableRef = Boolean(options.gitRef) && versions.every((entry) => entry.missing);
const refProblem =
  `Not one of the ${MANIFESTS.length} manifests is readable at ${options.gitRef}. ` +
  "Either that ref is not in this clone — fetch it — or it names a tree this repository did not write.";
if (unreadableRef) {
  console.error(refProblem);
} else if (line !== null) {
  for (const entry of versions) {
    const said = entry.missing ? "<missing>" : (entry.version ?? "<no version field>");
    console.log(`  ${entry.version === line ? "✅" : "❌"} ${entry.file} is ${said}`);
  }
  if (stamp.version !== null) {
    console.log(`  ${stamp.version === line ? "✅" : "❌"} ${stamp.file} is stamped ${stamp.version}`);
  } else if (options.requireStamp) {
    console.log(`  ❌ ${stamp.file} ${stamp.missing ? "is missing" : "carries no LINE stamp"}`);
  }
}

if (problems.length === 0) {
  console.log(`✅ ${expected} agrees with the tree: every version in it is the line ${line}.`);
  process.exit(0);
}

// The other half of the same sentence. `problems` holds one entry per manifest
// — six of them, each saying a file in the version set is missing and asking
// whether the package was deleted — and annotating all six sends the reader to
// the wrong six files immediately after the accurate one-line diagnosis above.
// One problem with the ref is reported as one problem, and the exit code is
// the same either way.
if (unreadableRef) {
  const detail = `${refProblem} It was asked whether ${expected} describes it, from ${source}.`;
  if (onGitHub) console.log(`::error title=The git ref could not be read::${detail}`);
  console.error(`\n1 problem. ${options.gitRef} is not a tree this check can read.`);
  process.exit(1);
}

for (const problem of problems) {
  const detail =
    `${problem.detail} The version being written is ${expected}, from ${source}. ` +
    "Nothing derived from it can be trusted while they disagree, because every other string in " +
    "the chain is computed from a name rather than read from the tree (ADR 0037 D3).";
  if (onGitHub) console.log(`::error title=${problem.title}::${detail}`);
  console.error(`❌ ${problem.title}: ${detail}`);
}
console.error(`\n${problems.length} problem(s). ${expected} does not describe this tree.`);
process.exit(1);
