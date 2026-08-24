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
  readManifestVersions,
  versionFromGitTag,
} from "./lib/version-agreement.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const onGitHub = Boolean(process.env.GITHUB_ACTIONS);

function parseArgs(argv) {
  const options = { expected: null, source: null, gitRef: null, root: repoRoot, imageLabel: null };
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
// here is what lets every caller pass its own surface's spelling.
const expected = versionFromGitTag(options.expected) ?? options.expected;
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
  const detail = `${source} would be published as ${expected}, and ${problem} (ADR 0037 D4).`;
  if (onGitHub) console.log(`::error title=The image does not self-report the version being published::${detail}`);
  console.error(`❌ ${detail}`);
  process.exit(1);
}

const versions = readManifestVersions({ root: options.root, gitRef: options.gitRef });
const { line, problems } = checkAgreement({ expected, versions });

const where = options.gitRef ? `at ${options.gitRef}` : "in the working tree";
console.log(`Asserting ${MANIFESTS.length} manifests ${where} against ${expected}, from ${source}.`);

// Two failures must not be dressed up as six drifting manifests. A bad version
// string is one problem with the string, and a ref this clone does not have is
// one problem with the ref; the per-file listing below is only meaningful when
// there is a line to compare against and a tree that answered.
const unreadableRef = Boolean(options.gitRef) && versions.every((entry) => entry.missing);
if (unreadableRef) {
  console.error(
    `Not one of the ${MANIFESTS.length} manifests is readable at ${options.gitRef}. ` +
      "Either that ref is not in this clone — fetch it — or it names a tree this repository did not write.",
  );
} else if (line !== null) {
  for (const entry of versions) {
    const said = entry.missing ? "<missing>" : (entry.version ?? "<no version field>");
    console.log(`  ${entry.version === line ? "✅" : "❌"} ${entry.file} is ${said}`);
  }
}

if (problems.length === 0) {
  console.log(`✅ ${expected} agrees with the tree: every manifest carries the line ${line}.`);
  process.exit(0);
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
