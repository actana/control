#!/usr/bin/env node
// Sweep stale tags out of the two `-dev` image repositories (ADR 0023 D45).
//
// Docker Hub has no automatic tag garbage collection: every push to every pull
// request leaves a tag behind forever, and `panel-dev` / `core-dev` would
// otherwise grow without bound. This is the clock that empties them.
//
// It is a destructive unattended cron holding a delete-capable credential, so
// the shape is deliberate:
//
//   * every decision about *what* is stale lives in scripts/lib/dev-tag-sweep.mjs,
//     which is pure and unit-tested. This file does HTTP and logging.
//   * the repository allowlist is re-asserted immediately before each DELETE,
//     not once at startup.
//   * `--dry-run` is a first-class mode and the one to reach for when changing
//     anything here.
//   * every tag is reported with its verdict, kept or deleted. A sweep that
//     printed only its deletions would look identical to one whose tag listing
//     was truncated.
//
// Usage:
//   node scripts/sweep-dev-tags.mjs --namespace actana --github-repo actana/control
//   node scripts/sweep-dev-tags.mjs --namespace actana --github-repo actana/control --dry-run
//
// --namespace <ns>       Docker Hub namespace holding the repositories.
// --github-repo <o/r>    Where the pull requests live, for the open/closed check.
// --repositories <list>  Comma-separated. Every entry must be on the allowlist.
// --max-age-days <n>     Overrides the 30-day staleness threshold.
// --dry-run              Decide and report; delete nothing.
// --summary <path>       Append the report here as well (GITHUB_STEP_SUMMARY).
//
// Credentials, from the environment:
//   DOCKERHUB_USERNAME        the account the cleanup token belongs to
//   DOCKERHUB_CLEANUP_TOKEN   a personal access token with delete permission
//   GITHUB_TOKEN              read access to the repository's pull requests

import * as fs from "node:fs";

import { makeFail, parseArgs, stringFlag } from "./lib/cli.mjs";
import {
  DEFAULT_MAX_AGE_DAYS,
  SWEEPABLE_REPOSITORIES,
  assertSweepable,
  formatPlan,
  planSweep,
} from "./lib/dev-tag-sweep.mjs";

const fail = makeFail("dev-tag-sweep");
const log = (message) => console.log(`[dev-tag-sweep] ${message}`);

const args = parseArgs(process.argv.slice(2));
const namespace = stringFlag(args, "namespace", fail);
const githubRepo = stringFlag(args, "github-repo", fail);
const repositoriesFlag = stringFlag(args, "repositories", fail);
const maxAgeFlag = stringFlag(args, "max-age-days", fail);
const summaryPath = stringFlag(args, "summary", fail);
const dryRun = args["dry-run"] === true;

if (!namespace) fail("--namespace is required");
if (!githubRepo || !githubRepo.includes("/")) fail("--github-repo must be owner/name");

const maxAgeDays = maxAgeFlag === undefined ? DEFAULT_MAX_AGE_DAYS : Number(maxAgeFlag);
if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) fail("--max-age-days must be a positive number");

const repositories = repositoriesFlag
  ? repositoriesFlag.split(",").map((entry) => entry.trim()).filter(Boolean)
  : SWEEPABLE_REPOSITORIES;

// Before a single network call: an operator who mistypes a repository finds
// out here, not after the first delete.
for (const repository of repositories) {
  try {
    assertSweepable(repository);
  } catch (error) {
    fail(error.message);
  }
}

const username = process.env.DOCKERHUB_USERNAME;
const cleanupToken = process.env.DOCKERHUB_CLEANUP_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;

if (!githubToken) fail("GITHUB_TOKEN is not set — the open/closed check cannot run without it");
if (!dryRun && (!username || !cleanupToken)) {
  fail(
    "DOCKERHUB_USERNAME and DOCKERHUB_CLEANUP_TOKEN must both be set to delete. " +
      "See docs/REPO_SETUP.md — the cleanup token is a second, delete-capable PAT.",
  );
}

async function json(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} → HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/**
 * The pull requests that are open right now.
 *
 * A hard failure rather than an empty set on error: an empty set means "every
 * `pr-*` tag belongs to a closed pull request", which would sweep the image of
 * every review in flight.
 */
async function openPullRequestNumbers() {
  const [owner, repo] = githubRepo.split("/");
  const numbers = new Set();

  for (let page = 1; ; page += 1) {
    const batch = await json(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    for (const pull of batch) numbers.add(pull.number);
    if (batch.length < 100) break;
  }

  return numbers;
}

/** A Docker Hub JWT. The /v2/repositories endpoints do not accept a raw PAT. */
async function dockerHubJwt() {
  const body = await json("https://hub.docker.com/v2/users/login/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: cleanupToken }),
  });
  if (!body.token) {
    throw new Error(
      "no JWT in the login response. This endpoint rejects organization access tokens " +
        "('Cannot log into an organization account') — DOCKERHUB_CLEANUP_TOKEN must be a personal access token.",
    );
  }
  return body.token;
}

/**
 * Every tag in a repository.
 *
 * Paginated to exhaustion rather than capped: a truncated listing would report
 * a clean sweep over the first hundred tags and leave the rest to accumulate
 * silently, which is exactly the failure this job exists to prevent.
 */
async function listTags(jwt, repository) {
  const headers = jwt ? { Authorization: `JWT ${jwt}` } : {};
  const tags = [];
  let url = `https://hub.docker.com/v2/namespaces/${namespace}/repositories/${repository}/tags?page_size=100`;

  while (url) {
    const page = await json(url, { headers });
    for (const result of page.results ?? []) {
      tags.push({ name: result.name, lastUpdated: result.last_updated ?? result.tag_last_pushed ?? null });
    }
    url = page.next ?? null;
  }

  return tags;
}

async function deleteTag(jwt, repository, tag) {
  // The guard, re-asserted at the delete itself (D38). Checking once at
  // startup would leave any later route to this function unprotected, and this
  // is the call Docker Hub cannot undo.
  assertSweepable(repository);

  const response = await fetch(
    `https://hub.docker.com/v2/repositories/${namespace}/${repository}/tags/${encodeURIComponent(tag)}/`,
    { method: "DELETE", headers: { Authorization: `JWT ${jwt}` } },
  );
  if (response.status !== 204 && response.status !== 202 && response.status !== 200) {
    throw new Error(`DELETE ${repository}:${tag} → HTTP ${response.status} ${await response.text()}`);
  }
}

const now = new Date();
let openPullRequests;
try {
  openPullRequests = await openPullRequestNumbers();
} catch (error) {
  fail(`could not list open pull requests: ${error.message}`);
}
log(`${openPullRequests.size} open pull request(s) on ${githubRepo}`);

// A read-only dry run needs no credential at all, which is what makes it
// usable from a laptop while changing the rules.
let jwt = null;
if (username && cleanupToken) {
  try {
    jwt = await dockerHubJwt();
  } catch (error) {
    fail(`Docker Hub login failed: ${error.message}`);
  }
} else {
  log("no Docker Hub credential — listing tags anonymously, deleting nothing");
}

const report = [];
let failures = 0;

for (const repository of repositories) {
  let tags;
  try {
    tags = await listTags(jwt, repository);
  } catch (error) {
    console.error(`[dev-tag-sweep] could not list ${repository}: ${error.message}`);
    failures += 1;
    continue;
  }

  const plan = planSweep({ repository, tags, openPullRequests, now, maxAgeDays });
  report.push(formatPlan(plan, { dryRun: dryRun || !jwt }));
  console.log(formatPlan(plan, { dryRun: dryRun || !jwt }));

  if (dryRun || !jwt) continue;

  for (const decision of plan.deletes) {
    try {
      await deleteTag(jwt, repository, decision.name);
    } catch (error) {
      console.error(`[dev-tag-sweep] ${error.message}`);
      failures += 1;
    }
  }
}

if (summaryPath) {
  fs.appendFileSync(
    summaryPath,
    ["### `-dev` tag sweep", "", "```", ...report, "```", ""].join("\n"),
  );
}

if (failures > 0) fail(`${failures} repository or tag operation(s) failed — see above`);
log(dryRun ? "dry run complete — nothing was deleted." : "sweep complete.");
