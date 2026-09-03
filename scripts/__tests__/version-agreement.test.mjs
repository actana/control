// The version chain, asserted (ADR 0037).
//
// This file exists because of a specific class of green check: one that
// compares a version string to the name it was derived from. `beta-x.y.z` came
// off the branch name, `RELEASE_VERSION` came off the tag name, the tarball's
// filename and archive root and `core-manifest.json` all came off
// `RELEASE_VERSION` — so all of them agreed with each other by construction and
// with the six manifests by coincidence. Every one of those comparisons passes
// on a repository whose versions do not agree.
//
// So the assertions here are of two kinds and neither is a unit test of a
// happy path:
//
//   1. **the vocabulary**, because a counted beta is what every semver habit
//      produces and ADR 0036 C1 bans it on every surface;
//   2. **the wiring**, because the check exists only where a workflow calls it,
//      and a job that stops calling it is exactly as green as one that never
//      did.
//
// `scripts/__tests__/workflows.test.mjs` is #318's file and is not touched by
// this ticket; the assertions below sit here instead, which is also why the
// manifest-set binding is repeated from the other side rather than moved.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BETA_SUFFIX,
  INSTALLER_STAMP_FILE,
  INSTALLER_STAMP_PATTERN,
  MANIFESTS,
  SURFACES,
  betaOf,
  channelOf,
  checkAgreement,
  gitTagFor,
  imageVersionProblem,
  isBeta,
  isLine,
  lineFromImageTag,
  lineOf,
  readInstallerStamp,
  readManifestVersions,
  stripTagPrefix,
  trainImageTagFor,
  versionFromGitTag,
  versionProblem,
} from "../lib/version-agreement.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const workflow = (file) => fs.readFileSync(path.join(repoRoot, ".github/workflows", file), "utf8");
const doc = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");

/** One job block, from its key up to the next job at the same indent. */
const jobBlock = (source, name) => {
  const start = source.indexOf(`\n  ${name}:`);
  expect(start, `no ${name} job`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

/** A block with its comment lines removed — what the runner actually reads. */
const code = (block) =>
  block
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

describe("the vocabulary (ADR 0036 C1, ADR 0037 D1)", () => {
  it("calls x.y.z a line and x.y.z-beta its beta", () => {
    expect(isLine("0.4.1")).toBe(true);
    expect(isBeta("0.4.1-beta")).toBe(true);
    expect(channelOf("0.4.1")).toBe("release");
    expect(channelOf("0.4.1-beta")).toBe("beta");
    expect(betaOf("0.4.1")).toBe(`0.4.1${BETA_SUFFIX}`);
  });

  // The clause every ticket in this milestone reads, and the one a semver habit
  // breaks without noticing: `0.4.1-beta.1` parses cleanly everywhere, which is
  // precisely why refusing it has to be a check rather than a convention.
  it("refuses a counted beta by name, on any spelling of the counter", () => {
    for (const counted of ["0.4.1-beta.1", "0.4.1-beta1", "0.4.1-beta-2", "0.4.1-beta.rc1"]) {
      expect(versionProblem(counted), `${counted} was accepted`).toMatch(/counted beta/);
      expect(isBeta(counted)).toBe(false);
    }
    expect(versionProblem("0.4.1-beta")).toBeNull();
  });

  // ADR 0036 C1's own second paragraph: the constraint binds the beta channel
  // and does not touch the backport release candidate, whose shape carries an
  // identifier by design (ADR 0023 D30). A rule that banned both would make the
  // supported-line path unreleasable.
  it("leaves the backport release candidate alone", () => {
    expect(versionProblem("1.2.4-rc.1")).toBeNull();
    expect(channelOf("1.2.4-rc.1")).toBe("prerelease");
    expect(lineOf("1.2.4-rc.1")).toBe("1.2.4");
  });

  // ADR 0023 D46, checked here because this module is the reason that clause
  // is cheap. A sub-beta train `beta/0.4.5-f1` hands `--expected 0.4.5-f1` to
  // the push-time and promotion-time assertions, and they must compare the
  // manifests against the **line** — the tree on a sub-beta carries `0.4.5`,
  // exactly as the plain train's does. That already worked, and this is what
  // says so: the vocabulary is unamended by D46, and a change here that broke
  // it would strand a sub-beta's every push with nothing else red.
  it("reads a sub-beta train's version as a prerelease of its line (ADR 0023 D46)", () => {
    expect(versionProblem("0.4.5-f1")).toBeNull();
    expect(channelOf("0.4.5-f1")).toBe("prerelease");
    expect(lineOf("0.4.5-f1")).toBe("0.4.5");
    expect(lineOf("0.4.5-f12")).toBe("0.4.5");
    // Not a line and not a beta: a sub-beta is neither published nor cut for.
    // `betaOf` and `trainImageTagFor` take a line and refuse this, which is
    // what makes `beta-release.yml` strip the suffix before it composes
    // anything rather than discovering the problem at the registry.
    expect(isLine("0.4.5-f1")).toBe(false);
    expect(isBeta("0.4.5-f1")).toBe(false);
    expect(() => betaOf("0.4.5-f1")).toThrow(/not a line/);
    expect(() => trainImageTagFor("0.4.5-f1")).toThrow(/not a line/);
  });

  // The whole reason the suffix is `-fN` and not `.N`, in one assertion. A
  // fourth dot is not semver: it is not a line, not a prerelease of one, and
  // not a version this repository writes — so a train named `beta/0.4.5.1`
  // would fail here, after the cut, on every push.
  it("has no reading at all for a fourth dot (ADR 0023 D46)", () => {
    expect(lineOf("0.4.5.1")).toBeNull();
    expect(channelOf("0.4.5.1")).toBeNull();
    expect(versionProblem("0.4.5.1")).toMatch(/not a version this repository publishes/);
  });

  it("resolves every publication of a line back to that line", () => {
    expect(lineOf("0.4.1")).toBe("0.4.1");
    expect(lineOf("0.4.1-beta")).toBe("0.4.1");
    expect(lineOf("v0.4.1")).toBeNull();
    expect(versionFromGitTag("v0.4.1-beta")).toBe("0.4.1-beta");
    expect(gitTagFor("0.4.1-beta")).toBe("v0.4.1-beta");
    // `versionFromGitTag` answers what a tag names, structurally — a counted
    // beta is a well-formed prerelease and it says so. The ban lives in
    // `versionProblem` and nowhere else, which is what keeps the two questions
    // apart: what does this name, and may we publish it.
    expect(versionFromGitTag("v0.4.1-beta.1")).toBe("0.4.1-beta.1");
    expect(versionProblem("0.4.1-beta.1")).toMatch(/counted beta/);
    // A string that names nothing still loses its `v`, so the message a person
    // gets is about the string they typed rather than about a `v`.
    expect(versionFromGitTag("v0.4")).toBeNull();
    expect(stripTagPrefix("v0.4")).toBe("0.4");
    expect(stripTagPrefix("verify")).toBe("verify");
  });

  // The two beta spellings are different tags in the same repositories and both
  // mean one line. Nothing else in the repository says so in one place.
  it("reads both beta image-tag spellings as the same line", () => {
    expect(trainImageTagFor("0.4.1")).toBe("beta-0.4.1");
    expect(lineFromImageTag("beta-0.4.1")).toBe("0.4.1");
    expect(lineFromImageTag("0.4.1-beta")).toBe("0.4.1");
    expect(lineFromImageTag("0.4.1")).toBe("0.4.1");
    expect(lineFromImageTag("latest")).toBeNull();
    expect(lineFromImageTag("sha-abc1234")).toBeNull();
  });

  // Landmine 4 of this ticket, as a test: both answers an unlabelled image
  // gives today are wrong, and they are wrong differently.
  it("names the two version labels the images actually carry today", () => {
    expect(imageVersionProblem({ label: "24.04", expected: "0.4.1" })).toMatch(/Ubuntu base/);
    expect(imageVersionProblem({ label: "", expected: "0.4.1" })).toMatch(
      /carries no `org\.opencontainers\.image\.version` label/,
    );
    expect(imageVersionProblem({ label: "0.4.1", expected: "0.4.1" })).toBeNull();
    // The beta of a line carries the line, so the same digest satisfies both.
    expect(imageVersionProblem({ label: "0.4.1", expected: "0.4.1-beta" })).toBeNull();
    expect(imageVersionProblem({ label: "0.4.0", expected: "0.4.1" })).toMatch(/self-report/);
  });

  // The ban has to hold on this path *specifically*, and the test is here
  // rather than only in the vocabulary block because image mode is the one
  // caller that never reaches `checkAgreement` — the only other place
  // `versionProblem` is consulted. A counted beta agrees with its own line:
  // `lineOf("0.4.1-beta.1")` is `0.4.1`, which is exactly what a correctly
  // labelled image says, so without this the digest passes and the string
  // publishes. #319's beta retag is the image-mode caller ADR 0037 D8 promises
  // inherits the check (ADR 0036 C1, ADR 0037 D7).
  it("refuses a counted beta on the image path, where checkAgreement never runs", () => {
    expect(imageVersionProblem({ label: "0.4.1", expected: "0.4.1-beta.1" })).toMatch(/counted beta/);
    expect(imageVersionProblem({ label: "0.4.1", expected: "0.4.1-beta1" })).toMatch(/counted beta/);
    // The label agreeing with the line is what made it pass, so pin that the
    // agreement is no longer what decides it.
    expect(lineOf("0.4.1-beta.1")).toBe("0.4.1");
    // And the candidate is still not the beta: 0036 C1 binds one channel.
    expect(imageVersionProblem({ label: "1.2.4", expected: "1.2.4-rc.1" })).toBeNull();
  });
});

describe("the comparison reads content, not a name (ADR 0037 D3)", () => {
  it("agrees with this repository's own tree", () => {
    const versions = readManifestVersions({ root: repoRoot });
    const root = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    expect(checkAgreement({ expected: root, versions }).problems).toEqual([]);
    // And with the beta of the same line, which is the whole of what a beta cut
    // needs from this module (ADR 0036 D1).
    expect(checkAgreement({ expected: betaOf(root), versions }).problems).toEqual([]);
  });

  it("reports every drifting manifest rather than the first", () => {
    const versions = [
      { file: "package.json", version: "0.4.1" },
      { file: "packages/cli/package.json", version: "0.4.0" },
      { file: "packages/core/package.json", version: "9.9.9" },
    ];
    const { problems } = checkAgreement({ expected: "0.4.1", versions });
    expect(problems.map((p) => p.file)).toEqual(["packages/cli/package.json", "packages/core/package.json"]);
  });

  // A bad string is one problem with the string. Reporting it as six drifting
  // manifests would send the reader to the wrong six files.
  it("does not dress a bad version string up as manifest drift", () => {
    const versions = readManifestVersions({ root: repoRoot });
    const { problems } = checkAgreement({ expected: "0.4.1-beta.1", versions });
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("version-shape");
  });

  it("holds install.sh's stamp to the same line, and requires it only when asked", () => {
    const stamp = readInstallerStamp({ root: repoRoot });
    const root = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    expect(stamp.version, "install.sh carries no LINE stamp").toBe(root);

    const versions = readManifestVersions({ root: repoRoot });
    const stale = { file: INSTALLER_STAMP_FILE, kind: "stamp", version: "0.3.9" };
    expect(checkAgreement({ expected: root, versions, stamp: stale }).problems).toHaveLength(1);

    const unstamped = { file: INSTALLER_STAMP_FILE, kind: "stamp", version: null, unstamped: true };
    expect(checkAgreement({ expected: root, versions, stamp: unstamped }).problems).toEqual([]);
    expect(
      checkAgreement({ expected: root, versions, stamp: unstamped, stampRequired: true }).problems,
    ).toHaveLength(1);
  });

  // The stamp is rewritten by a documented `sed`, so the shape this module
  // matches and the shape the runbook edits have to be the same shape.
  it("matches the stamp the documented cut writes", () => {
    expect(INSTALLER_STAMP_PATTERN.test('LINE="1.2.3"')).toBe(true);
    const runbook = doc("docs/ci-cd.md");
    expect(runbook, "the runbook no longer rewrites LINE= in install.sh").toContain(
      `sed -i.bak 's/^LINE=".*"$/LINE="x.y.z"/' ${INSTALLER_STAMP_FILE}`,
    );
  });
});

// Landmine one of #327, from the third side.
//
// `ci.yml`'s `MANIFESTS` and `docs/ci-cd.md`'s `files=()` are described in the
// code as the same set by construction, and `workflows.test.mjs` binds that
// pair. This module is now a third holder of the set, and an unbound third copy
// would be the same bug with one more place to forget: a seventh package added
// to two lists and missed in the third would be cut stamped, gated correctly,
// and silently skipped by the checker that runs on the push.
describe("the manifest set is one set held in three places", () => {
  it("equals the bash array Train rules gates on", () => {
    const job = code(jobBlock(workflow("ci.yml"), "train-rules"));
    const array = /MANIFESTS=\(([^)]*)\)/.exec(job);
    expect(array, "ci.yml's Train rules has no MANIFESTS array").not.toBeNull();
    expect(array[1].replace(/\\\n/g, " ").trim().split(/\s+/).sort()).toEqual([...MANIFESTS].sort());
  });

  it("equals the array in the cut a person performs", () => {
    const arrays = [...doc("docs/ci-cd.md").matchAll(/^files=\(([^)]*)\)/gm)];
    expect(arrays.length, "docs/ci-cd.md § Cutting a train has no single files=() array").toBe(1);
    expect(arrays[0][1].trim().split(/\s+/).sort()).toEqual([...MANIFESTS].sort());
  });

  it("is every workspace manifest and nothing else", () => {
    const packages = fs
      .readdirSync(path.join(repoRoot, "packages"))
      .filter((name) => fs.existsSync(path.join(repoRoot, "packages", name, "package.json")))
      .map((name) => `packages/${name}/package.json`);
    expect([...packages, "package.json"].sort()).toEqual([...MANIFESTS].sort());
  });

  // ADR 0036 D4. `install.sh` is the one thing a cut writes that must never
  // join the list: the set refuses to grow past the workspace packages, and
  // "just add it to the list" is the obvious edit and the wrong one.
  it("keeps the installer out of the manifest set", () => {
    expect(MANIFESTS).not.toContain(INSTALLER_STAMP_FILE);
    const job = code(jobBlock(workflow("ci.yml"), "train-rules"));
    expect(job, "the installer stamp has no assertion of its own").toContain("assert_installer_stamp");
    const array = /MANIFESTS=\(([^)]*)\)/.exec(job)[1];
    expect(array).not.toContain(INSTALLER_STAMP_FILE);
  });
});

// The wiring. Every one of these is a gap the issue names as a green check on a
// repository whose versions do not agree, and each is closed by a call that a
// tidying edit could silently remove.
describe("every writer reads the tree before it writes (ADR 0037 D3)", () => {
  const checker = "scripts/assert-version-agreement.mjs";

  it("asserts a train's version on push, not only on a pull request", () => {
    const source = workflow("ci.yml");
    const job = jobBlock(source, "train-versions");
    expect(job).toContain("if: startsWith(github.ref, 'refs/heads/beta/')");
    expect(code(job)).toContain(checker);
    expect(code(job)).toContain("--require-stamp");
    // The push half must not inherit the pull-request-only condition that is
    // the reason it exists.
    expect(code(job)).not.toContain("github.event_name == 'pull_request'");
    expect(code(jobBlock(source, "train-rules"))).toContain("github.event_name == 'pull_request'");
  });

  // The gap, stated as the issue states it: a train whose six manifests all say
  // 9.9.9 published actana/core:beta-0.4.1 with a green CI. The dependency is
  // what makes that impossible rather than merely checked somewhere.
  it("gates the beta-x.y.z image tag on that assertion", () => {
    const job = jobBlock(workflow("ci.yml"), "train-tags");
    expect(code(job)).toMatch(/needs: train-versions/);
    for (const image of ["panel-image-train", "core-image-train"]) {
      const caller = code(jobBlock(workflow("ci.yml"), image));
      expect(caller, `${image} does not need train-tags`).toContain("needs: train-tags");
      expect(caller, `${image} publishes no version to check`).toContain(
        "version: ${{ needs.train-tags.outputs.version }}",
      );
    }
  });

  it("asserts the tag against the tree before release.yml builds anything", () => {
    const source = workflow("release.yml");
    const resolve = code(jobBlock(source, "resolve"));
    expect(resolve).toContain(checker);
    expect(resolve).toContain("--git-ref");
    // Before the tarballs and before the images: every other job needs
    // `resolve`, so being in it is being first.
    for (const job of ["tarball", "tarball-macos", "panel", "core", "npm"]) {
      expect(code(jobBlock(source, job)), `${job} does not wait on resolve`).toMatch(/needs: \[?resolve/);
    }
  });

  it("asserts the train against the tree before promote.yml moves main", () => {
    const source = workflow("promote.yml");
    const resolve = code(jobBlock(source, "resolve"));
    expect(resolve).toContain(checker);
    // Against the promotion pull request's head, which is the commit `main`
    // becomes and the commit the tag names — not against the branch tip, which
    // is the state D16 refuses rather than one to follow.
    expect(resolve).toContain("--git-ref");
    expect(resolve).toContain("steps.facts.outputs.head_sha");
    expect(code(jobBlock(source, "advance"))).toMatch(/needs: \[resolve, verify/);
  });

  // A condition nothing satisfies is not a check. The `if:` on that assertion
  // asks for `verify` *and* a non-empty version, and the only `verify`-mode
  // callers there are are these two — so the condition and the callers have to
  // be asserted together or the step is dead code with a test that passes.
  // ADR 0037 §C row 3 says the assertion runs in verify as well as promote,
  // and this is what makes that sentence true.
  it("hands the promotion pull request's images the version they must self-report", () => {
    const source = workflow("ci.yml");
    const resolver = jobBlock(source, "pr-image-mode");
    expect(resolver, "pr-image-mode exposes no version output").toContain(
      "version: ${{ steps.mode.outputs.version }}",
    );
    // The line the promotion pull request would publish, taken off the head
    // branch beside the tag that names the same line — not computed, and not
    // read from the tree the check is about (ADR 0037 D1).
    const resolve = code(resolver);
    expect(resolve).toContain('tags="beta-${HEAD#beta/}"');
    expect(resolve, "the verify branch resolves no version").toContain('version="${HEAD#beta/}"');
    // Written before `why`, which stays the resolver's completion mark, and
    // carried across the failure boundary into the outputs.
    expect(resolve).toMatch(/echo "version=\$version"[\s\S]*echo "why=\$why"/);
    expect(resolve).toMatch(/version="\$\(value version\)"/);

    for (const image of ["panel-image", "core-image"]) {
      expect(code(jobBlock(source, image)), `${image} passes no version`).toContain(
        "version: ${{ needs.pr-image-mode.outputs.version }}",
      );
    }
  });

  it("hands both images a version to be held to", () => {
    const source = workflow("release.yml");
    for (const job of ["panel", "core"]) {
      expect(code(jobBlock(source, job)), `${job} publishes no version to check`).toContain(
        "version: ${{ needs.resolve.outputs.version }}",
      );
    }
  });
});

describe("an image says what version it is (ADR 0037 D4)", () => {
  const source = workflow("container-image.yml");

  it("takes a version, labels the bytes with the line, and asserts it", () => {
    expect(source).toMatch(/^ {6}version:$/m);
    const build = code(jobBlock(source, "build"));
    expect(build).toContain('--label "org.opencontainers.image.version=$IMAGE_VERSION"');
    expect(build).toContain('--build-arg "IMAGE_VERSION=$IMAGE_VERSION"');
    // The label is read out of the tree and never out of the input: a label
    // taken from the caller's string would be the tautology this whole chain
    // exists to remove.
    expect(build).toContain('line="$(jq -r .version package.json)"');
    expect(build).toContain('echo "IMAGE_VERSION=$line" >> "$GITHUB_ENV"');
  });

  it("refuses to re-point a tag at a digest that self-reports something else", () => {
    const build = code(jobBlock(source, "build"));
    expect(build).toContain("(inputs.mode == 'verify' || inputs.mode == 'promote') && inputs.version != ''");
    expect(build).toContain("--image-label");
    expect(build).toContain('.["org.opencontainers.image.version"]');
    // Upstream of every tag it protects: the retag lives in `publish`, which
    // needs `build`.
    expect(code(jobBlock(source, "publish"))).toContain("needs: [resolve, build]");
  });

  it("gives the Panel image the label it has never carried", () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, "deploy/panel.Dockerfile"), "utf8");
    expect(dockerfile).toContain("ARG IMAGE_VERSION=");
    expect(dockerfile).toContain('org.opencontainers.image.version="${IMAGE_VERSION}"');
  });

  it("overrides the version the Core image inherits from its base", () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, "deploy/core.Dockerfile"), "utf8");
    // The Core's labels are applied by the build rather than by the Dockerfile,
    // and the base is what makes that necessary: `ubuntu:24.04` carries
    // `org.opencontainers.image.version=24.04`, which is inherited through
    // `FROM` and is the wrong answer rather than a missing one.
    expect(dockerfile).toMatch(/^FROM ubuntu:/m);
    expect(code(jobBlock(workflow("container-image.yml"), "build"))).toContain(
      '--label "org.opencontainers.image.version=$IMAGE_VERSION"',
    );
  });

  it("checks the digest's version beside its revision before main moves", () => {
    const verify = code(jobBlock(workflow("promote.yml"), "verify"));
    expect(verify).toContain("org.opencontainers.image.revision");
    expect(verify).toContain("org.opencontainers.image.version");
    expect(verify).toContain("--image-label");
  });
});

// The unit tests above hold the vocabulary and the wiring tests hold the call
// sites. Neither runs the thing a workflow actually runs, and both findings in
// the first review of this change were reproduced from a command line rather
// than from a unit — a check that returns the right value and exits zero is
// still a green check.
describe("the checker refuses from the command line, as a workflow runs it", () => {
  const run = (args) =>
    spawnSync(process.execPath, [path.join(repoRoot, "scripts/assert-version-agreement.mjs"), ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "true" },
    });

  it("exits non-zero on a counted beta in image mode", () => {
    const bad = run(["--expected", "0.4.1-beta.1", "--image-label", "0.4.1", "--source", "actana/core:0.4.1-beta.1"]);
    expect(bad.status, `exited ${bad.status}\n${bad.stdout}${bad.stderr}`).toBe(1);
    expect(`${bad.stdout}${bad.stderr}`).toMatch(/counted beta/);
    // The annotation names the failure it is: the label is fine, the string is
    // not, and "rebuild the image" is the wrong remedy to headline.
    expect(bad.stdout).toContain("::error title=Not a version this repository writes::");

    const good = run(["--expected", "0.4.1-beta", "--image-label", "0.4.1", "--source", "actana/core:0.4.1-beta"]);
    expect(good.status, `${good.stdout}${good.stderr}`).toBe(0);
  });

  // A ref this clone cannot read is one problem with the ref. Six annotations
  // about six manifests point the reader at the wrong six files, immediately
  // after an accurate one-line diagnosis says the ref is the problem.
  it("reports an unreadable ref once, not once per manifest", () => {
    const result = run(["--expected", "0.4.1", "--git-ref", "deadbeef".repeat(5)]);
    expect(result.status).toBe(1);
    const annotations = [...result.stdout.matchAll(/^::error /gm)];
    expect(annotations, `six manifests annotated for one bad ref\n${result.stdout}`).toHaveLength(1);
    expect(result.stdout).toContain("::error title=The git ref could not be read::");
    expect(result.stdout).not.toContain("A manifest in the version set is missing");
  });

  // The other side of the same gate: a ref that *is* readable and disagrees
  // must still name every manifest that drifted. Suppressing the loop on the
  // wrong condition would silence the check this ticket exists to add.
  it("still names every drifting manifest when the ref reads", () => {
    const result = run(["--expected", "v9.9.9", "--git-ref", "HEAD"]);
    expect(result.status).toBe(1);
    // The six manifests and the installer's stamp: seven surfaces in this tree
    // carry the line, and every one that disagrees is named (ADR 0036 D4).
    expect([...result.stdout.matchAll(/^::error /gm)]).toHaveLength(MANIFESTS.length + 1);
    expect(result.stdout).toContain(INSTALLER_STAMP_FILE);
  });
});

// The catalogue is the deliverable of this ticket as much as the checks are:
// the acceptance criteria ask for it to live somewhere durable and to name what
// is authoritative for each row. Data and prose drift, so they are bound.
describe("the catalogue is complete and recorded (ADR 0037 D2)", () => {
  const adr = doc("docs/adr/0037-one-version-per-line.md");

  it("names every surface in the record", () => {
    expect(SURFACES.length).toBeGreaterThan(0);
    for (const surface of SURFACES) {
      expect(adr, `ADR 0037 does not name the ${surface.id} surface`).toContain(`\`${surface.id}\``);
    }
  });

  it("says what is authoritative for each one", () => {
    for (const surface of SURFACES) {
      expect(["tree", "derived"], `${surface.id} has no authority`).toContain(surface.authority);
      expect(surface.writtenBy.length).toBeGreaterThan(0);
    }
  });

  it("amends the two clauses of ADR 0023 whose counts this ticket corrects", () => {
    const adr0023 = doc("docs/adr/0023-release-trains-and-digest-promotion.md");
    const notes = [...adr0023.matchAll(/^> \*\*[A-Za-z]+ [0-9-]+ by \[#327\]/gm)];
    expect(notes.length, "ADR 0023 carries no #327 amendment").toBeGreaterThanOrEqual(2);
  });
});
