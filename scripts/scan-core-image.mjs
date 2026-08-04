#!/usr/bin/env node
// The CVE gate — Trivy against the built Core image (ADR 0016 D11, D37).
//
// Runs on the bytes a build produced, not on a Dockerfile and not on a
// lockfile: `pnpm audit` cannot see the base image at all, and Trivy has no
// dev/prod notion, so neither substitutes for the other. This is the third of
// D37's three populations — the OS layer plus the `node_modules` the image
// ships — and it is the only one that scans an image.
//
// One scan, two outputs. Everything is *reported*; only fixable CRITICAL and
// HIGH *gate*. What is in and out of the gate, and why, is decided in
// scripts/lib/image-cve-gate.mjs and written up in docs/ci-cd.md.
//
// Usage:
//   node scripts/scan-core-image.mjs --image <tag>
//   node scripts/scan-core-image.mjs --input <image.tar>   # a saved image
//
// --image <tag>    Scan an image in the local engine's store.
// --input <tar>    Scan a `docker save` / `podman save` tarball instead.
// --json <path>    Also keep the raw Trivy JSON here, for a CI artifact.
//
// Needs `trivy` on PATH. Exits 1 on a gating finding, on a scanner error, or
// if the checked-in suppression did not apply.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { makeFail, parseArgs, stringFlag } from "./lib/cli.mjs";
import {
  IGNORE_POLICY_FILE,
  assertSuppressionApplied,
  buildReport,
  formatGateFailure,
  formatSummary,
} from "./lib/image-cve-gate.mjs";

const fail = makeFail("core-image-cve");
const log = (message) => console.log(`[core-image-cve] ${message}`);

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const image = stringFlag(args, "image", fail);
const input = stringFlag(args, "input", fail);
const keepJsonAt = stringFlag(args, "json", fail);

if ((image && input) || (!image && !input)) fail("pass exactly one of --image <tag> or --input <tar>");

const ignorePolicy = path.join(repoRoot, IGNORE_POLICY_FILE);
if (!fs.existsSync(ignorePolicy)) {
  fail(`${IGNORE_POLICY_FILE} is missing. It is the repository's only vulnerability allowlist (ADR 0016 D7).`);
}

const jsonPath = keepJsonAt ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "core-cve-")), "trivy.json");

// `--scanners vuln`: the secret scanner roughly doubles the run and this job
// is the CVE gate — secrets are `pnpm scan:secrets`, on the source, where a
// finding names a commit somebody can revert.
const trivyArgs = [
  "image",
  ...(input ? ["--input", input] : [image]),
  "--scanners",
  "vuln",
  "--ignore-policy",
  ignorePolicy,
  "--format",
  "json",
  "--output",
  jsonPath,
];

log(`trivy ${trivyArgs.join(" ")}`);
const scan = spawnSync("trivy", trivyArgs, { stdio: ["ignore", "inherit", "inherit"] });
if (scan.error) fail(`could not run trivy: ${scan.error.message}`);
if (scan.status !== 0) fail(`trivy exited ${scan.status}`);

let report;
try {
  report = buildReport(JSON.parse(fs.readFileSync(jsonPath, "utf8")));
} catch (error) {
  fail(`could not read Trivy's output at ${jsonPath}: ${error.message}`);
}

// Before grading it: prove the allowlist did what the file says it does. A
// Trivy ignore file it cannot apply filters nothing and warns about nothing,
// so a green gate is not on its own evidence that the suppression worked.
assertSuppressionApplied(report, fail);

console.log(formatSummary(report));

if (report.gating.length > 0) fail(formatGateFailure(report));

log(
  report.ungated.length > 0
    ? `gate passed — nothing fixable and CRITICAL/HIGH outside ${report.ungated.length} reported-only finding(s).`
    : "gate passed — no fixable CRITICAL or HIGH findings.",
);
