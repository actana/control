#!/usr/bin/env node
// Decide what a release publishes — and whether `latest` is part of it.
//
// The thin edge of scripts/lib/release-latest.mjs: this file reads the tag
// ladder out of git and renders the decision as `key=value` lines; the module
// holds every rule and is unit-tested. `release.yml`'s `resolve` job pipes
// stdout straight into `$GITHUB_OUTPUT`, so **stdout carries the machine
// answer and nothing else** — the explanation goes to stderr, where the step
// log picks it up.
//
// Usage:
//   node scripts/release-tags.mjs --mode promote  --version 1.4.0
//   node scripts/release-tags.mjs --mode backport --version 1.2.4 --published "v1.4.0 v1.2.3"
//
// --mode <promote|backport>  where the tag lives (ADR 0023 D26).
// --version <x.y.z>          the version being released, no leading `v`.
// --published <list>         the tag ladder, whitespace- or comma-separated.
//                            Defaults to `git tag --list 'v*'` in the current
//                            repository, which needs the tags fetched.
//
// Output, on stdout:
//   tags=1.4.0 latest        space-separated, for container-image.yml
//   latest=true|false        for `gh release create --latest=`
//   prerelease=true|false    for `gh release create --prerelease=`
//   npm_tag=latest|next|…    for `npm publish --tag`, which otherwise defaults
//                            to `latest` the way the other two surfaces used to
//   mode=promote|backport

import { execFileSync } from "node:child_process";

import { makeFail, parseArgs, stringFlag } from "./lib/cli.mjs";
import { RELEASE_MODES, resolveReleaseTags } from "./lib/release-latest.mjs";

const fail = makeFail("release-tags");

const args = parseArgs(process.argv.slice(2));
const mode = stringFlag(args, "mode", fail);
const version = stringFlag(args, "version", fail);
const publishedFlag = stringFlag(args, "published", fail);

if (!mode) fail(`--mode is required (${RELEASE_MODES.join(" | ")})`);
if (!version) fail("--version is required");

/**
 * The ladder. `git tag --list` rather than the GitHub Releases API: a tag is
 * the record a release leaves behind (D40) and needs no token, and the answer
 * must not depend on whether somebody edited a Release afterwards.
 *
 * A repository with no tags at all is the first release, which is legitimately
 * the highest — so an empty list is an answer, not a failure. A git that
 * *errors* is not: it would look identical to "no releases yet" and would hand
 * `latest` to whatever version happened to be building.
 */
const publishedTags = () => {
  if (publishedFlag !== undefined) return publishedFlag.split(/[\s,]+/);
  try {
    return execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split("\n");
  } catch (error) {
    return fail(
      `could not read the tag ladder with \`git tag --list 'v*'\` (${error.message}). ` +
        "The latest guard compares this release against every published version, so an " +
        "unreadable ladder is not an answer — fetch the tags (actions/checkout with " +
        "fetch-depth: 0) and re-run.",
    );
  }
};

let decision;
try {
  decision = resolveReleaseTags({ mode, version, published: publishedTags() });
} catch (error) {
  fail(error.message);
}

console.error(`[release-tags] ${decision.reason}`);
console.error(
  `[release-tags] ${decision.tags.join(" ")} on Docker Hub; GitHub Release latest=${decision.latest} prerelease=${decision.prerelease}; npm dist-tag ${decision.npmTag}`,
);

process.stdout.write(
  [
    `mode=${decision.mode}`,
    `tags=${decision.tags.join(" ")}`,
    `latest=${decision.latest}`,
    `prerelease=${decision.prerelease}`,
    `npm_tag=${decision.npmTag}`,
    "",
  ].join("\n"),
);
