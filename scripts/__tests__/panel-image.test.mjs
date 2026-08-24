import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CORE_APP_ROOT,
  CORE_HOME,
  CORE_IMAGE,
  CORE_PACKAGES,
  CORE_REFUSED_VERBS,
  CORE_PORT,
  PANEL_DATA_DIR,
  PANEL_DOCKERFILE,
  PANEL_IMAGE,
  PANEL_NODE_BIN,
  PANEL_PORT,
  PANEL_RUNTIME_USER,
  PANEL_TABLES,
  aptPackages,
  composeFacts,
  dockerfileFacts,
  readRepoFile,
  repoRoot,
  secondCoreBlock,
} from "../lib/panel-image.mjs";

// The one-deployable contract (web-panel-extraction issue 09): the two
// Dockerfiles, the one reference compose, and the release workflow are
// separate files that must agree on the image names, the ports, and the
// single data directory each side keeps its state in. These tests are the
// agreement.

const dockerfile = dockerfileFacts(readRepoFile(PANEL_DOCKERFILE));
const composeText = readRepoFile("deploy/docker-compose.yml");
const compose = composeFacts(composeText);
const workflow = readRepoFile(".github/workflows/release.yml");
// The build/smoke/push machinery moved into one reusable workflow so the PR,
// edge, and release paths share a single implementation; release.yml is
// now only the version-tag half. Assertions follow the code.
const imageWorkflow = readRepoFile(".github/workflows/container-image.yml");
// The same file with every comment line dropped — YAML's and the shell blocks'
// alike, both `#`. For assertions that must not be satisfiable by a comment,
// and for the negative ones, where a comment explaining why something is *not*
// done would otherwise read as the thing being done.
const imageWorkflowCode = imageWorkflow
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");
// The edge publish was a push-to-`main` condition inside ci.yml, not a workflow
// of its own — ADR 0016 D30 deleted images-edge.yml for being a fourth entry
// point to jobs that differ only in which tags come out the other end. The
// train publish replaced it in place (ADR 0023 D13); see "the train publish"
// below.
const ciWorkflow = readRepoFile(".github/workflows/ci.yml");
const coreDockerfile = readRepoFile("deploy/core.Dockerfile");
// Named apart from `compose.services.core`: one is the image's instructions,
// the other is the service that runs it, and the two are asserted side by side.
const coreImage = dockerfileFacts(coreDockerfile);

describe("Dockerfile", () => {
  it("lives in deploy/, not at the repo root", () => {
    expect(fs.existsSync(path.join(repoRoot, PANEL_DOCKERFILE))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "Dockerfile"))).toBe(false);
  });

  it("is named by every builder, since the repo root no longer implies it", () => {
    // The context stays the repo root, so each builder has to name the file.
    // Miss one and it looks for a root Dockerfile that is not there.
    expect(imageWorkflow).toContain(`--file ${PANEL_DOCKERFILE}`);
    expect(readRepoFile("scripts/smoke-panel-image.mjs")).toContain(PANEL_DOCKERFILE);
    // The reference compose used to be a third builder. It pulls now, so it
    // names an image rather than a Dockerfile — and nothing else in the tree
    // may quietly go back to building one that isn't there.
    expect(composeText).not.toContain("dockerfile:");
  });

  // ADR 0016 D24 replaced four assertions here rather than patching them to
  // green: the runtime is no longer a Node image at all, so "both stages are
  // the CI Node", "slim runtime", "runs as `node`", and "starts the entry the
  // bare-node path documents" were each about a shape that stopped existing.
  // The five that follow are D20–D23 stated as tests.

  // D20/D25. The build stage — and only the build stage — is the exact Node CI
  // tests against. The runtime's Node ships with the distroless base and is
  // deliberately a different patch release; asserting they match would be
  // asserting something we do not control and do not want.
  it("builds on the exact Node CI tests against, on the same Debian as the runtime", () => {
    const ciNode = readRepoFile(".github/workflows/ci.yml").match(/node-version:\s*(\S+)/)?.[1];
    expect(ciNode).toBeTruthy();
    const build = dockerfile.froms.find(({ alias }) => alias === "build");
    // trixie, not bookworm: a better-sqlite3 built against the older glibc
    // happens to load on the newer one, and the reverse does not. D25 removes
    // the reliance on that asymmetry rather than documenting it.
    expect(build.image).toBe(`node:${ciNode}-trixie`);
  });

  // D20. The runtime carries no shell, no package manager and no build
  // toolchain — which is what took the OS findings from 174 to 12. Pinned by digest
  // because the repository's 6,980 tags contain no version number anywhere:
  // four mutable names plus opaque build SHAs, so a tag is not a pin.
  it("ships a digest-pinned distroless runtime, with the full build stage left behind", () => {
    expect(dockerfile.froms.length).toBeGreaterThan(1);
    expect(dockerfile.froms.at(-1).image).toMatch(
      /^gcr\.io\/distroless\/nodejs24(:[\w.-]+)?@sha256:[0-9a-f]{64}$/,
    );
  });

  // D21. Numeric is load-bearing, not style: Kubernetes' runAsNonRoot
  // admission check cannot resolve a username, and fails the pod rather than
  // the check. The `node` user (uid 1000) does not exist in this base.
  it("runs as an unprivileged numeric uid:gid, never a username", () => {
    expect(dockerfile.users.at(-1)).toBe(PANEL_RUNTIME_USER);
    expect(PANEL_RUNTIME_USER).toMatch(/^\d+:\d+$/);
  });

  // D22. The single clause most likely to break a real deployment if it is
  // skimmed. COPY recreates the *destination* directory as root:root 0755 and
  // discards the staged directory's ownership and mode; only entries inside a
  // copied tree keep theirs. Docker seeds a fresh named volume from the
  // image's content *and* mode, so a staged `chown` yields a /data the Panel
  // cannot write to on every new deployment.
  it("creates /data with COPY --chown, never with a staged chown", () => {
    const data = dockerfile.copies.find((copy) => copy.dest === PANEL_DATA_DIR);
    expect(data).toBeTruthy();
    expect(data.from).toBe("build");
    expect(data.chown).toBe(PANEL_RUNTIME_USER);
    // A `chown /data` anywhere in the build stage would be the discarded form
    // wearing the right words.
    expect(dockerfile.runs.join("\n")).not.toMatch(/chown\s+\S+\s+\/data\b/);
  });

  // D23. HEALTHCHECK argv bypasses ENTRYPOINT and distroless's PATH does not
  // contain /nodejs/bin, so the naive ["node", …] form reports UNHEALTHY even
  // for a script that cannot fail.
  it("names node by absolute path in the healthcheck, since argv bypasses ENTRYPOINT", () => {
    // Exec form: the shell form would need a shell, and there isn't one.
    const argv = JSON.parse(dockerfile.healthcheck.match(/CMD\s*(\[.*\])\s*$/)[1]);
    expect(argv[0]).toBe(PANEL_NODE_BIN);
    expect(argv.join(" ")).toContain("/api/healthz");
  });

  // D23. node *is* the ENTRYPOINT, so CMD is argv to node. Leaving "node" in
  // the array makes node try to run a file literally named `node`.
  it("starts the Panel with the script path alone — node is the ENTRYPOINT", () => {
    expect(JSON.parse(dockerfile.cmd)).toEqual(["bin/panel.mjs"]);
  });

  // D23. podman drops HEALTHCHECK silently without --format docker, and a
  // builder that does the same would ship an image with no healthcheck while
  // every local build looks fine. Confirmed on the built bytes, not assumed.
  it("confirms the built image actually carries the healthcheck", () => {
    // Assert on the code that runs, not on prose about it: a comment
    // mentioning the healthcheck would satisfy a bare substring match while
    // the check itself had been deleted.
    const smoke = readRepoFile("scripts/smoke-panel-image.mjs");
    expect(smoke).toContain(`"image", "inspect"`);
    expect(smoke).toContain("config?.Healthcheck?.Test");
    // And again on the published multi-arch manifest, which is a different
    // artifact from the per-arch image the smoke ran against. Same reader as
    // the smoke — the daemon's own — applied per platform.
    expect(imageWorkflowCode).toContain("{{json .Config.Healthcheck}}");
    expect(imageWorkflowCode).toContain('docker pull --quiet --platform "linux/$arch"');
    expect(imageWorkflowCode).toContain(PANEL_NODE_BIN);
  });

  // Regression guard, not style. `imagetools inspect --format '{{json .Image}}'`
  // renders a Go struct that need not carry Healthcheck at all, and reading the
  // gate through it reported MISSING on both platforms of an image that had the
  // healthcheck — a red run on a healthy publish. The property worth keeping is
  // "this gate is never read through that format again".
  it("does not read the healthcheck back through imagetools' Go struct", () => {
    expect(imageWorkflowCode).not.toContain("{{json .Image}}");
  });

  // The native module compiled in the build stage has to dlopen under a
  // different Node and a different glibc in the runtime stage. The smoke
  // script proves it by reading the migrated schema back out of a running
  // container; this keeps the tables it looks for honest, so dropping one
  // from panel-db.ts cannot quietly weaken that proof.
  it("names every table the Panel migrates, so the smoke can prove better-sqlite3 loaded", () => {
    const schema = readRepoFile("packages/panel/src/server/panel-db.ts");
    const migrated = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect([...PANEL_TABLES].sort()).toEqual(migrated.sort());
  });

  it("installs the pinned pnpm from package.json's packageManager field", () => {
    const { packageManager } = JSON.parse(readRepoFile("package.json"));
    expect(readRepoFile(PANEL_DOCKERFILE)).toContain(`npm install -g ${packageManager}`);
  });

  it("exposes the port bin/panel.mjs defaults to", () => {
    expect(readRepoFile("packages/panel/bin/panel.mjs")).toContain(`DEFAULT_PORT = ${PANEL_PORT}`);
    expect(dockerfile.exposes).toEqual([PANEL_PORT]);
  });

  it("keeps all state in the one volume-backed data directory", () => {
    expect(dockerfile.env.AC_PANEL_DATA_DIR).toBe(PANEL_DATA_DIR);
    expect(dockerfile.volumes).toEqual([PANEL_DATA_DIR]);
  });

  it("ships no Electron leftovers into the build context", () => {
    const ignore = readRepoFile(".dockerignore");
    for (const entry of ["node_modules", ".git", "dist-electron"]) {
      expect(ignore).toContain(entry);
    }
  });
});

// ADR 0016 D41: one compose file, a Panel and a Core on one network, and no
// TLS terminator. The Caddy service and its Caddyfile are gone — operators
// bring their own edge, so the reference's job is to name the port to point it
// at. What replaced those assertions is the Core half.
describe("reference compose", () => {
  const panel = compose.services.panel;
  const coreService = compose.services.core;

  // ADR 0023. Both images are templated on one tag variable that defaults to
  // `latest`, so a clean checkout still builds nothing and still pulls the
  // current release — and `ACTANA_TAG=beta-0.2.0` moves *both* services.
  //
  // One variable, not two, is the assertion that matters: the Panel and its
  // Cores are version-locked, and a compose file offering `ACTANA_PANEL_TAG`
  // beside `ACTANA_CORE_TAG` would make a pair nobody ever tested a single
  // typo away. Written as a literal rather than built from the constants,
  // because the default is what a checkout with no `.env` resolves to and a
  // template that quietly lost its default would still match a looser pattern.
  const panelName = PANEL_IMAGE.split("/").pop();
  const coreName = CORE_IMAGE.split("/").pop();

  it("runs the published images, so a clean checkout builds nothing", () => {
    expect(panel.image).toBe(
      `\${ACTANA_IMAGE_NAMESPACE:-actana}/${panelName}:\${ACTANA_TAG:-latest}`,
    );
    expect(coreService.image).toBe(
      `\${ACTANA_IMAGE_NAMESPACE:-actana}/${coreName}:\${ACTANA_TAG:-latest}`,
    );
    expect(Object.keys(compose.services)).toEqual(["panel", "core"]);
  });

  it("moves both services from one tag variable, because they are version-locked", () => {
    const tagVariables = [...composeText.matchAll(/\$\{(ACTANA_[A-Z_]*TAG)[:}]/g)].map(
      (match) => match[1],
    );
    expect(tagVariables.length).toBeGreaterThan(0);
    expect([...new Set(tagVariables)]).toEqual(["ACTANA_TAG"]);
    // Documented where an operator looks for it, not only in a comment.
    expect(readRepoFile("deploy/.env.example")).toContain("ACTANA_TAG=");
  });

  // The `-dev` repositories are a different repository name, not a different
  // tag, so `ACTANA_TAG` alone cannot reach them (ADR 0023 D36). The override
  // that can must require the tag rather than default it: there is no
  // `latest` in a `-dev` repository, so a default would resolve to a tag that
  // does not exist and fail at the pull with nothing useful to say.
  it("reaches the pre-merge images with an override that demands a tag", () => {
    const override = readRepoFile("deploy/docker-compose.dev-images.yml");
    const dev = composeFacts(override);
    expect(dev.services.panel.image).toContain(`/${panelName}-dev:`);
    expect(dev.services.core.image).toContain(`/${coreName}-dev:`);
    for (const service of ["panel", "core"]) {
      expect(dev.services[service].image, `${service} defaults its -dev tag`).toContain(
        "${ACTANA_TAG:?",
      );
    }
  });

  it("publishes the Panel on loopback, and names no TLS terminator at all", () => {
    expect(panel.ports).toEqual([`127.0.0.1:${PANEL_PORT}:${PANEL_PORT}`]);
    // The two services above are the whole file, so there is no terminator to
    // find; the Caddyfile it used to read went with it. Prose still names
    // nginx/Traefik/Caddy, because pointing one at 7420 is what an operator
    // does next — that is the only place those words may appear now.
    expect(fs.existsSync(path.join(repoRoot, "deploy/Caddyfile"))).toBe(false);
    expect(composeText).not.toMatch(/^\s+image:.*caddy/im);
  });

  it("publishes no Core port — only the Panel reaches it, over the network", () => {
    expect(coreService.ports).toEqual([]);
  });

  it("keeps both services up across a host reboot", () => {
    for (const service of [panel, coreService]) {
      expect(service.scalars.restart).toBe("unless-stopped");
    }
  });

  it("mounts exactly one named volume on the Panel, at its data directory", () => {
    expect(panel.volumes).toEqual([`panel-data:${PANEL_DATA_DIR}`]);
    expect(compose.volumes).toContain("panel-data");
  });

  it("passes AC_SECRETS_KEY through so the key can live outside the volume", () => {
    expect(panel.environment.some((e) => e.startsWith("AC_SECRETS_KEY="))).toBe(true);
  });

  // D41. The image never guesses the public host — a container's default
  // hostname is its container ID, so a guessed one would re-mint the
  // certificate SAN on every recreation. `core` is the compose service name,
  // which is exactly what the Panel dials over this network.
  it("sets the public host to the service name, in the file the operator edits", () => {
    expect(coreService.environment).toContain("ACTANA_PUBLIC_HOST=core");
    // A baked default in the image would make this line decorative; the image
    // contract (D15) is that the variable is required and never guessed.
    expect(coreImage.env.ACTANA_PUBLIC_HOST).toBeUndefined();
  });

  // All four died with systemd, and the image carries tini as PID 1 (D14), so
  // `init:` would be a second reaper nobody asked for.
  it("carries none of the systemd fixture's container privileges", () => {
    for (const dead of ["privileged", "cgroup", "tmpfs", "init"]) {
      expect(coreService.scalars[dead]).toBeUndefined();
    }
    expect(coreService.volumes.some((v) => v.includes("/sys/fs/cgroup"))).toBe(false);
  });

  // D19 — the home is the state, because Harnesses write all over $HOME. The
  // repos bind mount is the one other mount, and it is the one an operator is
  // expected to change.
  it("gives the Core one named volume — its home — plus a swappable repos mount", () => {
    expect(coreService.volumes).toEqual([`core-home:${CORE_HOME}`, `./repos:${CORE_HOME}/repos`]);
    expect(compose.volumes).toEqual(["panel-data", "core-home"]);
    expect(composeText).toMatch(/Swappable for a named volume/);
    // The bind mount's host side has to exist in a clean checkout, or Docker
    // creates it root-owned and uid 1000 cannot write to its own repos.
    expect(fs.existsSync(path.join(repoRoot, "deploy/repos"))).toBe(true);
  });

  it("documents the env knob the compose path still has", () => {
    const example = readRepoFile("deploy/.env.example");
    expect(example).toContain("AC_SECRETS_KEY");
    expect(example).not.toContain("AC_PANEL_DOMAIN");
  });

  // D41's "nothing here is a singleton", tested rather than asserted: the
  // block an operator would paste is parsed as a service and compared with
  // the one it was copied from. Three things differ and nothing else does.
  describe("the second Core an operator pastes in", () => {
    const block = secondCoreBlock(composeText);
    const second = composeFacts(`services:\n${block}`).services.core2;

    it("is uncommentable into a real service", () => {
      expect(block).toBeTruthy();
      expect(second).toBeTruthy();
    });

    it("differs from the first Core in its name, its host and its volume", () => {
      expect(second.image).toBe(coreService.image);
      expect(second.scalars.restart).toBe(coreService.scalars.restart);
      expect(second.ports).toEqual([]);
      expect(second.environment).toContain("ACTANA_PUBLIC_HOST=core2");
      expect(second.volumes[0]).toBe(`core2-home:${CORE_HOME}`);
      // Its own volume, not a second mount of the first Core's — which would
      // put two Cores' identities and databases in one directory.
      expect(second.volumes).not.toContain(coreService.volumes[0]);
      // And named volumes throughout, not a bind mount: a pasted-in service
      // has no host directory, so a `./repos2` would be created root-owned by
      // Docker and uid 1000 could not write to its own checkouts.
      expect(second.volumes.some((v) => v.startsWith("./"))).toBe(false);
    });
  });
});

describe("release workflow", () => {
  // The Panel image ships on a version tag — but the tag no longer *triggers*
  // anything (ADR 0023 D40, as amended by #326). `promote.yml` pushes the tag
  // as a record and then dispatches this workflow *at* it; a `push: tags`
  // trigger beside that would fire a second release run the first could not
  // even block, and the `workflow_call` that used to be the entry is gone
  // because it resolved this file from the caller's SHA. What is asserted here
  // is what did not change: the release is still entered with a `v*` tag, and
  // it is that tag the image jobs publish under. The triggers themselves are
  // pinned in scripts/__tests__/workflows.test.mjs.
  it("publishes the image for a version tag it is handed, not one it watches", () => {
    expect(workflow).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(workflow).not.toMatch(/^ {2}workflow_call:$/m);
    expect(workflow).not.toMatch(/tags:\s*\n\s*- "v\*"/);
    expect(workflow).toMatch(/description: "Tag to .*\(e\.g\. v0\.1\.0\)/);
  });

  it("delegates the build to the shared image workflow", () => {
    expect(workflow).toContain("./.github/workflows/container-image.yml");
  });

  // `tags="$version latest"` for anything without a `-` in it used to live
  // here as two lines of shell, and it was the whole of the `latest` rule —
  // no highest-version test, so a backport of an old line would have moved
  // `:latest` backwards for every operator (D28). The decision moved to
  // scripts/lib/release-latest.mjs, where the prerelease case is one of three
  // and all of them are covered by scripts/__tests__/release-latest.test.mjs.
  // What this file asserts is the wiring: one decision, reaching the images.
  it("takes its tag list from the tested latest guard, not from inline shell", () => {
    expect(workflow).toContain("node scripts/release-tags.mjs");
    expect(workflow).not.toContain("$version latest");
    expect(workflow).toContain("tags: ${{ needs.resolve.outputs.tags }}");
  });

  // D30 lives in the tag regex as much as in the tag list: `v0` and `v0.1`
  // would publish the moving `:0` / `:0.1` ladder the clause forbids, and
  // `v0.1.0+abc` is neither a legal Docker tag nor a prerelease by the `*-*`
  // test below it, so it would move :latest.
  it("accepts a three-component version tag and nothing else", () => {
    const pattern = workflow.match(/=~ \^(v\[0-9\].*?)\$ \]\]/)?.[1];
    expect(pattern).toBeTruthy();
    const accepts = new RegExp(`^${pattern.replace(/\[\.\]/g, "\\.")}$`);
    for (const tag of ["v0.1.0", "v1.0.0-rc.1", "v10.20.30"]) {
      expect(accepts.test(tag)).toBe(true);
    }
    for (const tag of ["v0", "v0.1", "v0.1.0+abc", "0.1.0", "vlatest"]) {
      expect(accepts.test(tag)).toBe(false);
    }
  });

  // "Fix a typo without cutting a release" used to be a `workflow_dispatch` of
  // this file, and is now a weekly tick of housekeeping.yml (ADR 0023 D43). It
  // still only works if the sync reads a branch rather than a tag — which
  // there it does by never checking out a ref at all.
  it("no longer carries the description sync", () => {
    expect(workflow).not.toContain("  descriptions:");
    expect(workflow).not.toContain("docs/images/");
  });

  // D34: one file for the whole tag, not four that have to be kept in step.
  it("is the only release entry point — the three it replaced are gone", () => {
    for (const gone of [
      "core-release.yml",
      "images-release.yml",
      "dockerhub-description.yml",
    ]) {
      expect(fs.existsSync(path.join(repoRoot, ".github/workflows", gone))).toBe(false);
    }
  });

  // D28, as amended. Every target builds on a runner of its own architecture —
  // the tarballs carry native modules copied from the build host, so a
  // cross-compiled leg would be a guess. The mac leg is its own job rather
  // than a third matrix row because `environment:` is job-level, and putting
  // the approval pause on this matrix would stall the Linux legs behind it.
  it("builds each tarball on a runner of its own architecture", () => {
    const tarball = workflow.slice(
      workflow.indexOf("  tarball:"),
      workflow.indexOf("  tarball-macos:"),
    );
    expect(tarball).toContain("target: linux-x64");
    expect(tarball).toContain("target: linux-arm64");
    expect(tarball).toContain("ubuntu-24.04-arm");
    // No macOS row crept into the Linux matrix — matched on the keys rather
    // than the word, since the slice runs up to the mac job's own comment.
    expect(tarball).not.toMatch(/os: macos/);
    expect(tarball).not.toMatch(/target: mac-/);

    const macTarball = workflow.slice(
      workflow.indexOf("  tarball-macos:"),
      workflow.indexOf("  installer-e2e:"),
    );
    expect(macTarball).toContain("TARGET: mac-arm64");
    expect(macTarball).toMatch(/runs-on: macos-/);
  });

  // The guard that makes a silently missing architecture a red build rather
  // than a checksum file covering part of the release. The 3 is the count of
  // CORE_TARGETS.
  it("composes SHA256SUMS with --expect 3", () => {
    expect(workflow).toContain("compose-core-shasums.mjs --dir core-tarballs --expect 3");
  });

  // D29: the installer's contract is the two asset names and bin/actana. The
  // installer itself is not an asset — it is fetched from main.
  it("attaches the tarballs and SHA256SUMS, and never install.sh", () => {
    const publish = workflow.slice(workflow.indexOf("  github-release:"));
    expect(publish).toMatch(/-name '\*\.tar\.gz' -o -name 'SHA256SUMS'/);
    // Prose about install.sh is the point of the header; a *step* that touched
    // it would be the asset D29 forbids.
    const steps = publish
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(steps).not.toContain("install.sh");
  });

  // The rule belongs "in any future release review verbatim" (D29), which
  // means the release workflow's own header — the file a reviewer has open.
  it("quotes ADR 0016 D29's installer-contract rule verbatim in its header", () => {
    const adr = readRepoFile("docs/adr/0016-the-0-1-0-shape.md");
    // The blockquote D29 introduces, not every blockquote in the ADR.
    const afterD29 = adr.slice(adr.indexOf("**D29 —")).split("\n");
    const first = afterD29.findIndex((line) => line.startsWith("> "));
    const quote = afterD29
      .slice(first)
      .slice(
        0,
        afterD29.slice(first).findIndex((line) => !line.startsWith("> ")),
      )
      .join(" ");
    // Markdown emphasis and comment markers differ; the words must not.
    const words = (text) => text.replace(/[>#*`]/g, " ").replace(/\s+/g, " ").trim();
    expect(words(quote)).not.toBe("");
    expect(words(workflow)).toContain(words(quote));
  });

  // D31, amended by ADR 0018: Docker Hub is the only registry, so a missing
  // credential fails the release before anything is built — on any repo,
  // fork or not. There is no longer a registry that authenticates for free.
  it("fails a missing Docker Hub credential before building anything", () => {
    expect(workflow).toMatch(/DOCKERHUB_TOKEN/);
    expect(workflow).toContain("::error title=Missing Docker Hub credential");
    expect(workflow).not.toContain("Publishing to GHCR only");
  });

  it("pushes the image name the compose file pulls", () => {
    expect(imageWorkflow).toContain(PANEL_IMAGE.split("/").pop());
    expect(imageWorkflow).toContain("docker.io/");
  });

  it("builds each architecture on a runner of that architecture", () => {
    expect(imageWorkflow).toContain("ubuntu-24.04");
    expect(imageWorkflow).toContain("ubuntu-24.04-arm");
  });

  it("smokes the image before anything is published", () => {
    expect(imageWorkflow).toContain("smoke-panel-image.mjs");
    // The push step must come after the smoke step, or "smoked before
    // published" is only true by accident of job ordering.
    expect(imageWorkflow.indexOf("smoke-panel-image.mjs")).toBeLessThan(
      imageWorkflow.indexOf("Push the per-arch tags"),
    );
  });

  it("publishes to Docker Hub and nowhere else", () => {
    // ADR 0018: GHCR was retired. A pushing build without credentials fails
    // in `resolve`, before anything is built — there is nowhere else to
    // publish — and a PR build (push: false) needs no credentials at all.
    expect(imageWorkflow).toContain("docker.io/");
    expect(imageWorkflow).not.toContain("ghcr.io");
    expect(imageWorkflow).toContain("::error title=Missing Docker Hub credential");
  });

  it("derives the registry namespace instead of hardcoding an owner", () => {
    expect(imageWorkflow).toContain("github.repository_owner");
  });
});

// The train publish is what the edge publish became (ADR 0023 D13): `:edge`
// published from `main`, and under the train model `main` is only ever a
// released version, so `:edge` would have been a second name for `:latest`.
// The jobs sit where the edge jobs sat, reusing the same build — that is the
// substitution ADR 0016's one-build-implementation property depends on, and
// these tests are what stop it drifting back into a second implementation.
describe("the train publish", () => {
  it("lives in ci.yml rather than a workflow of its own", () => {
    expect(fs.existsSync(path.join(repoRoot, ".github/workflows/images-edge.yml"))).toBe(false);
    expect(ciWorkflow).toContain("./.github/workflows/container-image.yml");
    expect(ciWorkflow).toMatch(/branches:\s*\n(?:\s*#.*\n)*\s*- "beta\/\*\*"/);
  });

  it("has retired :edge and the sha- tag on main, job and tag", () => {
    // The prose is allowed to say what was retired; the code is not allowed to
    // still do it. `main` no longer triggers this workflow at all (D41).
    const code = ciWorkflow
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toContain("edge");
    expect(code).not.toMatch(/^ {6}- main$/m);
  });

  it("publishes from a train push, and only from a train push", () => {
    // The two sets of image jobs are mutually exclusive — one reads the event,
    // the other the ref — which is what stops any single run building an image
    // twice. The train jobs key on the ref rather than on `!= 'pull_request'`
    // so a `workflow_dispatch` republishes a train the way images-edge.yml's
    // own dispatch did, while a dispatch anywhere else publishes nothing.
    for (const [job, condition] of [
      ["panel-image:", "github.event_name == 'pull_request'"],
      ["core-image:", "github.event_name == 'pull_request'"],
      ["panel-image-train:", "startsWith(github.ref, 'refs/heads/beta/')"],
      ["core-image-train:", "startsWith(github.ref, 'refs/heads/beta/')"],
    ]) {
      const start = ciWorkflow.indexOf(`\n  ${job}`);
      expect(start, `ci.yml has no ${job} job`).toBeGreaterThan(-1);
      expect(ciWorkflow.slice(start, start + 300)).toContain(condition);
    }
  });

  // D7. `beta-x.y.z` moves per merge and lives in the repositories people
  // deploy from; `sha-<short>` never moves and lives in `-dev`, because the
  // sweep that deletes it needs a credential D36 keeps out of the release
  // repositories. Both come off one build, so they name one digest (D11).
  it("tags beta-x.y.z and an immutable per-commit tag, and never moves :latest", () => {
    // Read out of `train-tags` specifically: `pr-image-mode` emits outputs of
    // the same names, and matching the file at large would assert on whichever
    // job happens to come first.
    const trainTags = ciWorkflow.slice(
      ciWorkflow.indexOf("\n  train-tags:"),
      ciWorkflow.indexOf("\n  panel-image-train:"),
    );
    const emitted = trainTags.match(/echo "tags=(.*?)"/)?.[1];
    const emittedDev = trainTags.match(/echo "dev_tags=(.*?)"/)?.[1];
    expect(emitted).toBe("beta-$version");
    expect(emittedDev).toBe("sha-${SHA:0:7}");
    for (const job of ["panel-image-train:", "core-image-train:"]) {
      const block = ciWorkflow.slice(ciWorkflow.indexOf(`\n  ${job}`), ciWorkflow.length);
      expect(block).toContain("tags: ${{ needs.train-tags.outputs.tags }}");
      expect(block).toContain("dev_tags: ${{ needs.train-tags.outputs.dev_tags }}");
    }
    expect(emitted).not.toContain("latest");
    expect(emittedDev).not.toContain("latest");
  });

  // D20. A documentation-only merge must still republish: otherwise
  // `beta-x.y.z`'s revision label names an older commit and the promotion
  // assertion fails, so a README fix would block the release.
  it("rebuilds a train merge unconditionally", () => {
    expect(ciWorkflow).not.toContain("paths-ignore:");
  });

  // D7 again, from the other side: two merges landing 30 seconds apart must
  // not finish out of order and leave the moving tag on older bytes.
  it("never cancels a train publish in flight", () => {
    const concurrency = ciWorkflow.slice(
      ciWorkflow.indexOf("\nconcurrency:"),
      ciWorkflow.indexOf("\npermissions:"),
    );
    expect(concurrency).toContain("cancel-in-progress: ${{ !startsWith(github.ref, 'refs/heads/beta/') }}");
  });

  it("publishes the Core image alongside the Panel", () => {
    for (const wf of [workflow, ciWorkflow]) {
      expect(wf).toContain("image: panel");
      expect(wf).toContain("image: core");
    }
  });
});

// The pull request image (ADR 0023 D32–D38). One check name, four behaviours,
// and the two that build nothing are the load-bearing ones: a required check
// whose job is *skipped* stays Pending forever and blocks the pull request
// permanently, which is why "nothing to build" is an early successful exit
// rather than a job-level `if:`.
describe("the pull request image", () => {
  const modeJob = ciWorkflow.slice(
    ciWorkflow.indexOf("\n  pr-image-mode:"),
    ciWorkflow.indexOf("\n  panel-image:"),
  );

  it("resolves all four modes, and announces the one it took", () => {
    for (const mode of ["build", "verify", "pass"]) {
      expect(modeJob, `no ${mode} mode`).toContain(`mode=${mode}`);
    }
    // The fork case is the fourth: build, with the push withheld (D34).
    expect(modeJob).toContain("HEAD_REPO");
    for (const mode of ["build", "verify", "pass"]) {
      expect(imageWorkflow, `${mode} is never announced`).toMatch(
        new RegExp(`::notice title=.*image — ${mode}`),
      );
    }
  });

  // D12, and the trap that makes it more than tidiness. `container-image.yml`
  // pushes per-arch `<stage>-<arch>` tags *before* stitching the manifest, so
  // two open pull requests sharing `stage: ci` would overwrite each other's —
  // and the stitch could assemble a manifest from another pull request's
  // bytes. Harmless while PR builds pushed nothing; corrupting now they do.
  it("discriminates the scaffolding tags per pull request, never `ci`", () => {
    expect(modeJob).toContain('stage="pr-$PR"');
    expect(ciWorkflow).not.toMatch(/^ {6}stage: ci$/m);
  });

  // D10. Mutable on purpose — what it points at is what is under discussion —
  // and not `sha-`, which this repository already uses for the opposite thing.
  it("tags pr-<prid><YYYYMM> into the -dev repositories only", () => {
    expect(modeJob).toContain('dev_tags="pr-${PR}$(date -u +%Y%m)"');
    expect(modeJob).not.toMatch(/^\s*tags="pr-/m);
  });

  // D33 from the third direction. `panel-image` and `core-image` both carry
  // `needs: pr-image-mode`, and a `needs:` whose upstream *fails* is reported
  // as skipped — so a resolver that can fail is a required check that can
  // stay Pending forever, which is the trap the four modes exist to avoid.
  // The resolve is therefore split: a step that thinks and may fail, and a
  // step that only reads a file and defaults what is missing. Both are
  // `continue-on-error`, so no step's failure can reach the job's conclusion.
  it("cannot leave the two image checks skipped", () => {
    expect(modeJob.match(/continue-on-error: true/g) ?? []).toHaveLength(2);

    // The fallback is a build that publishes nothing — never `verify` or
    // `pass`, which report green having proved nothing, and never a push,
    // which would put bytes under a tag nothing finished choosing.
    const fallback = modeJob.slice(modeJob.indexOf("case \"$mode\" in"));
    expect(fallback).toContain("mode=build");
    expect(fallback).toContain("push=false");
    expect(fallback).toMatch(/::warning title=PR image mode fell back to build/);
  });

  // The partial-list hole in the same resolver: `pulls/:number/files`
  // truncates past 300 entries, and a documentation-only *slice* of a mixed
  // diff reads as documentation-only — a merged change whose image was never
  // built. `changed_files` off the PR payload is the count that cannot
  // truncate, so a short list is treated as no list at all.
  it("will not call a truncated file list documentation-only", () => {
    expect(modeJob).toContain("CHANGED_FILES: ${{ github.event.pull_request.changed_files }}");
    expect(modeJob).toContain('"$listed" -lt "${CHANGED_FILES:-0}"');
    // Emptying `files` is what makes the truncated case fall through to
    // `docs_only=false`; asserting the mechanism, not just the comparison.
    // The window is the truncation guard itself — it ends where the test it
    // guards begins, so a comparison that stopped emptying `files` fails here.
    const guard = modeJob.slice(
      modeJob.indexOf('"$listed" -lt'),
      modeJob.indexOf("docs_only=true"),
    );
    expect(guard).toContain('files=""');
  });

  // D37/D32: the gate is the build and the smoke. A Docker Hub outage must
  // not freeze merging, so the publish cannot fail the required check.
  it("cannot fail the required check on a publish", () => {
    for (const job of ["panel-image:", "core-image:"]) {
      const start = ciWorkflow.indexOf(`\n  ${job}`);
      expect(ciWorkflow.slice(start, start + 900)).toContain("push_required: false");
    }
    expect(imageWorkflowCode).toContain("continue-on-error: ${{ !inputs.push_required }}");
  });
});

// The Core image is a Core you run, not a machine you install one on: the
// image tag is the version, the ENTRYPOINT is the unit, and `actana setup`
// never runs (ADR 0016 D13). These tests are the clauses of §B and §C that a
// well-meaning cleanup would otherwise quietly undo.
describe("core image", () => {
  it("is built from deploy/core.Dockerfile, and the dev fixture is gone", () => {
    expect(imageWorkflow).toContain("deploy/core.Dockerfile");
    // D40 deleted deploy/dev/ outright rather than leaving it beside the real
    // image — it existed to fake a systemd machine for the tarball to install
    // on, which is the design this replaced, and it is what a newcomer would
    // otherwise copy.
    expect(fs.existsSync(path.join(repoRoot, "deploy/dev"))).toBe(false);
  });

  it("takes the Core tarball from a named build context, without a layer", () => {
    // artifacts/ is at the repo root and the build context is deploy/, so the
    // tarball cannot ride in on the main context. Bind-mounted rather than
    // COPYed because a COPY is its own layer, and deleting the file in the
    // next instruction would not shrink it.
    expect(coreDockerfile).toContain("--mount=type=bind,from=tarball");
    expect(coreDockerfile).not.toContain("COPY --from=tarball actana-core");
    expect(imageWorkflow).toContain("--build-context tarball=artifacts/core");
    expect(imageWorkflow).toContain("pnpm core:tarball");
  });

  // D5. The tag is rolling, so only the digest is a pin; and apt resolves
  // noble-security at build time, so the in-layer upgrade is what makes the
  // weekly rebuild collect anything at all.
  it("pins the base by digest, on a single Ubuntu 24.04 stage", () => {
    expect(coreImage.froms).toHaveLength(1);
    expect(coreImage.froms[0].image).toMatch(/^ubuntu:24\.04@sha256:[0-9a-f]{64}$/);
  });

  it("upgrades in the same RUN layer that installs, not a later one", () => {
    const install = coreImage.runs.filter((run) => run.includes("apt-get install"));
    expect(install).toHaveLength(1);
    expect(install[0]).toMatch(/apt-get update.*apt-get upgrade -y.*apt-get install/s);
  });

  // D6 — the package set is the whole CVE story, so it is asserted exactly.
  it("installs the agreed package set and nothing else", () => {
    const install = coreImage.runs.find((run) => run.includes("apt-get install"));
    expect(aptPackages(install)).toEqual([...CORE_PACKAGES]);
  });

  it("names the package set, not the base, as why the CVE number moved", () => {
    // "we changed the base" is the wrong summary and would mislead the next
    // reader. Asserted on the mechanism rather than on a count, because the
    // counts move with every scan and a stale number in a comment is exactly
    // the failure this clause exists to prevent.
    expect(coreDockerfile).toContain("linux-libc-dev");
    expect(coreDockerfile).toMatch(/the base is NOT the mechanism/);
  });

  // D8 — nodejs.org tarball, verified against that release's own SHASUMS.
  it("takes Node 24 from nodejs.org, sha256-verified", () => {
    expect(coreImage.args.NODE_VERSION).toMatch(/^24\./);
    const install = coreImage.runs.find((run) => run.includes("nodejs.org"));
    expect(install).toContain("https://nodejs.org/dist/v${NODE_VERSION}");
    expect(install).toContain("SHASUMS256.txt");
    expect(install).toContain("sha256sum -c");
  });

  it("warns against 'simplifying' the Node install to apt", () => {
    // noble ships Node 18, and `nodejs` is in universe — whose security
    // updates are Ubuntu Pro-gated. Both regressions in one edit.
    expect(coreDockerfile).toMatch(/apt-get install nodejs/);
    expect(coreDockerfile).toMatch(/universe/);
  });

  // D12 — 1000:1000 explicitly, because useradd's own pick is 1001:100 and
  // that breaks every bind-mounted repo.
  it("removes the stock ubuntu user and pins core to 1000:1000", () => {
    const account = coreImage.runs.find((run) => run.includes("useradd"));
    expect(account).toContain("userdel");
    expect(account).toMatch(/groupadd --gid 1000 core/);
    expect(account).toMatch(/useradd --uid 1000 --gid 1000/);
    expect(coreImage.users.at(-1)).toBe("core");
  });

  it("gives NOPASSWD sudo to core and to nobody else", () => {
    const sudoers = coreImage.runs.filter((run) => run.includes("NOPASSWD"));
    expect(sudoers).toHaveLength(1);
    expect(sudoers[0]).toContain("core ALL=(ALL) NOPASSWD:ALL");
    expect(sudoers[0]).toContain("/etc/sudoers.d/core");
  });

  // D14 — tini is PID 1 so reparented Harnesses get reaped; baked in, because
  // `--init` is opt-in and a bare `docker run` would skip it.
  it("runs the daemon under tini as PID 1", () => {
    expect(coreImage.entrypoint).toBe('["/usr/bin/tini", "--"]');
    expect(coreImage.cmd).toBe('["actana", "daemon"]');
  });

  // D15 — the operator contract is three ACTANA_* variables; everything here
  // is a private image constant the container mode depends on.
  it("bakes the container-mode environment", () => {
    expect(coreImage.env).toMatchObject({
      ACTANA_CONTAINER: "1",
      AC_CORE_REMOTE: "1",
      AC_CORE_LINK_HOST: "0.0.0.0",
      AC_APP_PATH: `${CORE_APP_ROOT}/app`,
      AC_USER_DATA_DIR: `${CORE_HOME}/.local/share/actana/data`,
      AC_CORE_MATERIAL_FILE: `${CORE_HOME}/.config/actana/material.json`,
      NPM_CONFIG_PREFIX: `${CORE_HOME}/.local`,
    });
    expect(coreImage.env.PATH).toContain(`${CORE_APP_ROOT}/bin`);
    expect(coreImage.env.PATH).toContain(`${CORE_HOME}/.local/bin`);
  });

  it("exposes the port from the same ARG as ACTANA_PORT", () => {
    expect(coreImage.args.ACTANA_PORT).toBe(String(CORE_PORT));
    expect(coreImage.env.ACTANA_PORT).toBe("${ACTANA_PORT}");
    expect(coreImage.exposesRaw).toEqual(["${ACTANA_PORT}"]);
  });

  // D9 — ~1.15 GB of the ~1.4 GB a baked image would weigh, stale within days
  // of a build, and four vendors' binaries nobody has licence-cleared.
  // Asserted against the instructions, not the file text: the comments name
  // every one of these on purpose, to say why it is absent.
  it("bakes no Harnesses", () => {
    const built = coreImage.runs.join("\n");
    for (const harness of ["@anthropic-ai/claude-code", "@openai/codex", "opencode", "cursor"]) {
      expect(built).not.toContain(harness);
    }
    // One global install is not a Harness: npm replacing its own bundled copy
    // (the NPM_VERSION pin, where the image's only fixable CRITICAL/HIGH
    // live), installed from the SHA-512-checked local tarball. Strip that
    // exact form; anything else that matches still fails.
    const withoutNpmItself = built.replace('npm install -g "${npm_tgz}"', "");
    expect(withoutNpmItself).not.toMatch(/npm (install|i) -g/);
  });

  it("keeps systemd, and the machine-shaped install, out entirely", () => {
    const built = coreImage.runs.join("\n");
    for (const dead of ["systemd", "loginctl", "linger", "core-provision", "actana setup"]) {
      expect(built).not.toContain(dead);
    }
  });

  it("is smoked before it is pushed", () => {
    expect(imageWorkflow.indexOf("smoke-core-image.mjs")).toBeLessThan(
      imageWorkflow.indexOf("Push the per-arch tags"),
    );
  });

  // D36. The image smoke replaced `panel-e2e-core-in-a-box`, which needed
  // --privileged and the host cgroup to boot a systemd fixture. Nothing that
  // boots this image may reach for either again.
  it("is smoked by booting it, with no privileged container anywhere", () => {
    // The code, not the prose: the header names both on purpose, to say what
    // this replaced and why it needs neither.
    const smoke = readRepoFile("scripts/smoke-core-image.mjs")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(smoke).not.toContain("--privileged");
    expect(smoke).not.toContain("cgroup");
    // The job is gone, not renamed. Matched as a job key so the prose that
    // records what replaced it can go on saying the name.
    expect(readRepoFile(".github/workflows/ci.yml")).not.toMatch(/^ {2}panel-e2e-core-in-a-box:/m);
    // …and so is the fixture behind it. `systemd-container.mjs` stays: the
    // installer e2es are a different seam and D36 keeps them.
    expect(readRepoFile("scripts/lib/core-fixture.mjs")).not.toContain(
      "export async function startContainerCore",
    );
    expect(fs.existsSync(path.join(repoRoot, "scripts/lib/systemd-container.mjs"))).toBe(true);
  });

  // Docker publishes the port at container start and `docker-proxy` answers a
  // handshake before anything inside is listening, so a TCP probe against the
  // published port returns immediately and every leg that "waits" for a boot
  // reads a volume the daemon has not written yet. The daemon's own sentinel
  // is the only readiness signal here, and it is printed after the material is
  // persisted — so this guards against the probe drifting back to the port.
  it("waits for the daemon's own listening sentinel, not for the published port", () => {
    const smoke = readRepoFile("scripts/smoke-core-image.mjs")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(smoke).toContain("LISTENING_SENTINEL");
    // `net.connect` against `container.port` was that probe. Nothing in this
    // script should be dialling the published port to decide readiness.
    expect(smoke).not.toContain("net.connect");
  });

  // The smoke runs `actana <verb>` inside the container, so its verb list is a
  // copy of the Core's own refusal table. A copy that drifts is a verb that
  // silently stops being smoked — so the copy is checked against the original.
  it("smokes every verb the Core actually refuses in a container", () => {
    const table = readRepoFile("packages/cli/src/actana-container.ts");
    const body = table.slice(table.indexOf("const DOCKER_EQUIVALENT"));
    const verbs = [...body.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]);
    expect(verbs.length).toBeGreaterThan(0);
    expect([...CORE_REFUSED_VERBS]).toEqual(verbs);
  });

  // The Trivy gate and the boot-and-pair smoke are the same job on purpose
  // (T46): an image that fails either must not reach a registry, and splitting
  // them across jobs means the scanned bytes and the booted bytes are two
  // builds rather than one.
  it("scans and boots the same built image in one job", () => {
    const build = imageWorkflow.slice(
      imageWorkflow.indexOf("  build:"),
      imageWorkflow.indexOf("  publish:"),
    );
    expect(build).toContain("smoke-core-image.mjs");
    expect(build).toContain("scan-core-image.mjs");
  });
});

// Docker Hub rejects an oversized description with a 400, which would only
// surface as a red workflow after the fact. Catch it at the length instead.
describe("docker hub descriptions", () => {
  // The sync moved out of release.yml and onto the weekly tick, covering all
  // four repositories rather than the two a release publishes (ADR 0023 D43).
  const housekeeping = readRepoFile(".github/workflows/housekeeping.yml");
  const IMAGES = ["panel", "core", "panel-dev", "core-dev"];

  for (const image of IMAGES) {
    it(`${image} has a description file within Docker Hub's 25000-byte limit`, () => {
      const body = readRepoFile(`docs/images/${image}.md`);
      expect(body.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(25_000);
    });
  }

  it("syncs all four images, and each short description fits in 100 bytes", () => {
    for (const image of IMAGES) {
      expect(housekeeping).toContain(`sync ${image} docs/images/${image}.md`);
    }
    for (const [, short] of housekeeping.matchAll(/^\s+"(.+?)" \|\| rc=1$/gm)) {
      expect(Buffer.byteLength(short, "utf8")).toBeLessThanOrEqual(100);
    }
  });

  // The `-dev` pages exist because their repositories are public and would
  // otherwise describe themselves as releases (D36). The warning is the page.
  it.each(["panel-dev", "core-dev"])("tells a reader not to deploy %s", (image) => {
    const body = readRepoFile(`docs/images/${image}.md`).toLowerCase();
    expect(body).toContain("do not deploy");
    expect(body).toContain("not a release");
  });

  // D31/D33. One PAT does both jobs: an OAT can push images but answers
  // "Cannot log into an organization account" on /v2/users/login, so choosing
  // an OAT would mean paying for Team or Business *and still* making a PAT.
  it("authenticates the sync with the same PAT the image push uses", () => {
    const descriptions = housekeeping.slice(housekeeping.indexOf("  descriptions:"));
    expect(descriptions).toContain("secrets.DOCKERHUB_TOKEN");
    expect(descriptions).toContain("secrets.DOCKERHUB_USERNAME");
    // The second credential is deleted, everywhere — a secret nothing reads is
    // a secret nobody rotates.
    for (const file of [
      ".github/workflows/release.yml",
      ".github/workflows/housekeeping.yml",
      ".github/workflows/container-image.yml",
      "docs/REPO_SETUP.md",
      "docs/ci-cd.md",
    ]) {
      expect(readRepoFile(file)).not.toContain("DOCKERHUB_DESCRIPTION_");
    }
  });

  // The token belongs to a person and dies with that account (D31). That is a
  // documented rotation step, not a design flaw — but only if it is documented.
  it("documents PAT rotation in the repo setup guide", () => {
    const setup = readRepoFile("docs/REPO_SETUP.md");
    expect(setup.toLowerCase()).toContain("rotat");
  });

  // ADR 0016 D33 gated the sync on the two release image publishes so a page
  // could not describe a version nobody can pull. That rationale did not
  // survive the move (D43) and must not be reconstructed: a `needs:` here
  // would be it coming back, and the `-dev` pages have no publish to wait for.
  it("waits for no publish job, because it no longer describes one release", () => {
    const descriptions = housekeeping.slice(
      housekeeping.indexOf("  descriptions:"),
      housekeeping.indexOf("  dev-audit:"),
    );
    expect(descriptions).not.toMatch(/^\s+needs:/m);
    expect(workflow).not.toContain("  descriptions:");
  });

  // D33. `actana/core` was a systemd fixture that needed --privileged, the host
  // cgroup and a hardcoded `--public-host core`, and both the page and the
  // label said so. That design is gone (D40), and these pages are the public
  // face of the two images — they are also the one place the old text can
  // survive unnoticed, because nothing builds them.
  it("describes the Core image as the product, not as a development fixture", () => {
    for (const file of [
      "docs/images/core.md",
      "docs/images/panel.md",
      ".github/workflows/container-image.yml",
      ".github/workflows/release.yml",
      "docs/REPO_SETUP.md",
      "docs/ci-cd.md",
    ]) {
      const body = readRepoFile(file).toLowerCase();
      expect(body, `${file} still calls the Core image a fixture`).not.toMatch(
        /development[ -]fixture/,
      );
    }
  });

  // The page has to describe the image that exists: tini rather than systemd,
  // one required variable, one volume, and Harnesses arriving at runtime.
  it("documents the Core image's actual process model and contract", () => {
    const core = readRepoFile("docs/images/core.md");
    expect(core).toContain("`tini` is PID 1");
    expect(core).toContain("ACTANA_PUBLIC_HOST");
    expect(core).toContain("/home/core");
    expect(core).toContain("docker compose");
    expect(core).toContain("actana harnesses install");
    // The refused verbs of the old fixture, and the systemd it needed.
    expect(core).not.toContain("--privileged");
    expect(core).not.toContain("--public-host core");
  });

  it("links the images back to this repository via OCI labels", () => {
    // Docker Hub ignores these, but any registry UI that reads OCI labels —
    // and every `docker image inspect` — finds its way back to the source.
    expect(readRepoFile(PANEL_DOCKERFILE)).toContain("org.opencontainers.image.source");
    expect(imageWorkflow).toContain("org.opencontainers.image.source");
  });
});

describe("workflow hygiene", () => {
  it("release outputs contain no Electron artifacts", () => {
    const workflowDir = path.join(repoRoot, ".github", "workflows");
    for (const file of fs.readdirSync(workflowDir)) {
      expect(readRepoFile(path.join(".github/workflows", file)).toLowerCase()).not.toContain(
        "electron",
      );
    }
  });
});
