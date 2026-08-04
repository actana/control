#!/usr/bin/env node
// Do the image bases and the Core's Node still match upstream? (ADR 0016 D5,
// D10, D20.)
//
// It resolves every pin against its real upstream, using the same tag
// Dependabot would use for each, and says what has moved. Which pin is whose
// job, and why there is a checker as well as a Dependabot config, is written
// up once in docs/ci-cd.md § "The image bases, and what moves them".
//
// Usage:
//   node scripts/check-base-pins.mjs
//   node scripts/check-base-pins.mjs --json report.json
//   node scripts/check-base-pins.mjs --fix-node             # rewrite the ARG in place
//   node scripts/check-base-pins.mjs --github-output "$GITHUB_OUTPUT"
//
// Network only, no Docker: it speaks the registry HTTP API directly, so it
// runs anywhere Node and outbound HTTPS do. Exits 1 on an error and 0 on
// drift — a new Node release is news, not a broken build.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  NODE_MAJOR,
  SHIPPED_DOCKERFILES,
  hasDrifted,
  formatReport,
  latestVersionForMajor,
  parseFromLines,
  readNodeVersionArg,
  setNodeVersionArg,
  updateStrategyFor,
} from "./lib/base-pins.mjs";
import { makeFail, parseArgs, stringFlag } from "./lib/cli.mjs";

const fail = makeFail("base-pins");
const log = (message) => console.log(`[base-pins] ${message}`);

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const jsonPath = stringFlag(args, "json", fail);
const githubOutputPath = stringFlag(args, "github-output", fail);
const fixNode = args["fix-node"] === true;

const CORE_DOCKERFILE = "deploy/core.Dockerfile";
const NODE_INDEX_URL = "https://nodejs.org/dist/index.json";

/** The row the `ARG NODE_VERSION` pin reports under. */
const NODE_ROW = "NODE_VERSION";

/**
 * Who opens the PR for a drifted pin. Named here rather than spelled out at
 * each use because housekeeping.yml branches on it: a bare string matched
 * across that language boundary is a rename waiting to fail silently.
 */
const DEPENDABOT = "dependabot";
const THIS_WORKFLOW = "housekeeping.yml (base-pins)";

// Both list and OCI forms. Asking for only the Docker list media type gets a
// 404 from registries that publish an OCI index — gcr.io does — and asking for
// only the manifest types resolves a *platform* digest rather than the index
// digest the Dockerfile pins.
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

/**
 * The registry host and repository path to query for a parsed reference.
 *
 * `null` registry means Docker Hub, where an unqualified name is an official
 * image and lives under `library/` — the one piece of naming the registry API
 * does not do for you.
 */
function endpointFor({ registry, name }) {
  if (registry === null) {
    return { host: "registry-1.docker.io", repository: name.includes("/") ? name : `library/${name}` };
  }
  return { host: registry, repository: name };
}

/**
 * An anonymous pull token, obtained from the registry's own 401 challenge.
 *
 * Discovered rather than hardcoded: Docker Hub and gcr.io use different token
 * realms, and a hardcoded pair is a thing that works until the day a third
 * registry is added. A registry that does not challenge needs no token.
 */
async function pullToken(host, repository) {
  const probe = await fetch(`https://${host}/v2/`);
  if (probe.status !== 401) return null;

  const challenge = probe.headers.get("www-authenticate") ?? "";
  const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  if (!realm) throw new Error(`${host} asked for auth but named no realm: ${challenge}`);

  const url = new URL(realm);
  if (service) url.searchParams.set("service", service);
  url.searchParams.set("scope", `repository:${repository}:pull`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${host} refused an anonymous pull token (HTTP ${response.status})`);

  const body = await response.json();
  const token = body.token ?? body.access_token;
  if (!token) throw new Error(`${host} returned no token`);
  return token;
}

/** The digest a tag resolves to right now, or null if the tag is not there. */
async function digestOf(reference, tag) {
  const { host, repository } = endpointFor(reference);
  const token = await pullToken(host, repository);

  const response = await fetch(`https://${host}/v2/${repository}/manifests/${tag}`, {
    method: "HEAD",
    headers: {
      Accept: MANIFEST_ACCEPT,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${host}/${repository}:${tag} → HTTP ${response.status}`);

  return response.headers.get("docker-content-digest");
}

/** Every digest-pinned base across the shipped Dockerfiles, in file order. */
function pinnedBases() {
  return SHIPPED_DOCKERFILES.flatMap((file) =>
    parseFromLines(read(file))
      .filter((reference) => reference.digest !== null)
      .map((reference) => ({ file, reference, strategy: updateStrategyFor(reference) })),
  );
}

const rows = [];

for (const { file, reference, strategy } of pinnedBases()) {
  const label = `${reference.registry ? `${reference.registry}/` : ""}${reference.name}:${strategy.resolvesFrom}`;

  let upstream;
  try {
    upstream = await digestOf(reference, strategy.resolvesFrom);
  } catch (error) {
    fail(`could not resolve ${label}: ${error.message}`);
  }

  if (upstream === null) {
    // Only reachable for the tagless pin, and it is the failure this script
    // was written for: no `latest`, no Dependabot update, and nothing anywhere
    // else would have said so.
    fail(
      `${label} does not exist. ${file}:${reference.line} is pinned by digest with no tag, ` +
        "so Dependabot resolves its update from that tag — without it the base stops being updated silently.",
    );
  }

  rows.push({
    label,
    kind: strategy.kind,
    file,
    line: reference.line,
    pinned: reference.digest,
    upstream,
    owner: DEPENDABOT,
  });
}

const nodeArg = readNodeVersionArg(read(CORE_DOCKERFILE));
if (!nodeArg) fail(`${CORE_DOCKERFILE} has no \`ARG NODE_VERSION=\` line (ADR 0016 D8)`);

let nodeIndex;
try {
  const response = await fetch(NODE_INDEX_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  nodeIndex = await response.json();
} catch (error) {
  fail(`could not read ${NODE_INDEX_URL}: ${error.message}`);
}

const latestNode = latestVersionForMajor(nodeIndex, NODE_MAJOR);
if (!latestNode) fail(`nodejs.org lists no ${NODE_MAJOR}.x release`);

const nodeRow = {
  label: NODE_ROW,
  kind: "tarball",
  file: CORE_DOCKERFILE,
  line: nodeArg.line,
  pinned: nodeArg.version,
  upstream: latestNode,
  owner: THIS_WORKFLOW,
};
rows.push(nodeRow);

const drifted = rows.filter(hasDrifted);

if (fixNode && hasDrifted(nodeRow)) {
  const file = path.join(repoRoot, CORE_DOCKERFILE);
  fs.writeFileSync(file, setNodeVersionArg(fs.readFileSync(file, "utf8"), nodeRow.upstream));
  log(`${CORE_DOCKERFILE}: ${NODE_ROW} ${nodeRow.pinned} → ${nodeRow.upstream}`);
}

console.log(formatReport(rows));
for (const row of drifted) {
  log(`${row.label} is ${row.owner}'s to bump — ${row.file}:${row.line}`);
}

if (jsonPath) {
  fs.writeFileSync(jsonPath, `${JSON.stringify({ rows, drifted: drifted.map((row) => row.label) }, null, 2)}\n`);
}

// The workflow's step outputs are produced here, not re-derived from the JSON
// in a shell step: "has this drifted, and whose is it" would then have two
// definitions in two languages, and only one of them is tested.
if (githubOutputPath) {
  const digestDrift = drifted.filter((row) => row.owner === DEPENDABOT);

  fs.appendFileSync(
    githubOutputPath,
    [
      `node-current=${nodeRow.pinned}`,
      `node-latest=${nodeRow.upstream}`,
      `node-drifted=${hasDrifted(nodeRow)}`,
      `digest-drift=${digestDrift.map((row) => row.label).join(" ")}`,
      "",
    ].join("\n"),
  );
}
