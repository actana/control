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
const edgeWorkflow = readRepoFile(".github/workflows/images-edge.yml");
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
    // artifact from the per-arch image the smoke ran against.
    expect(imageWorkflow).toContain(".value.config.Healthcheck.Test");
    expect(imageWorkflow).toContain(PANEL_NODE_BIN);
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

  it("runs the published images, so a clean checkout builds nothing", () => {
    expect(panel.image).toBe(`${PANEL_IMAGE}:latest`);
    expect(coreService.image).toBe(`${CORE_IMAGE}:latest`);
    expect(Object.keys(compose.services)).toEqual(["panel", "core"]);
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
  it("builds the image on version tags, like the Core release", () => {
    expect(workflow).toMatch(/tags:\s*\n\s*- "v\*"/);
  });

  it("delegates the build to the shared image workflow", () => {
    expect(workflow).toContain("./.github/workflows/container-image.yml");
  });

  it("publishes :latest alongside the version, but never for a prerelease", () => {
    expect(workflow).toContain("$version latest");
    expect(workflow).toMatch(/version.*==.*\*-\*/);
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

  // D33's "fix a typo without cutting a release" only works if the sync reads
  // the branch it was dispatched from. Every other job pins the tag.
  it("syncs descriptions from the dispatched ref, not the tag", () => {
    const descriptions = workflow.slice(workflow.indexOf("  descriptions:"));
    expect(descriptions).toContain("actions/checkout@");
    expect(descriptions).not.toContain("ref: ${{ needs.resolve.outputs.ref }}");
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

  // D28. Two legs, not four: the darwin targets are dropped, so a release is
  // two tarballs and a SHA256SUMS over exactly those two.
  it("builds the two Linux tarballs on native runners and nothing on macOS", () => {
    const tarball = workflow.slice(workflow.indexOf("  tarball:"), workflow.indexOf("  panel:"));
    expect(tarball).toContain("target: linux-x64");
    expect(tarball).toContain("target: linux-arm64");
    expect(tarball).toContain("ubuntu-24.04-arm");
    expect(tarball).not.toContain("macos");
    expect(tarball).not.toContain("mac-arm64");
  });

  // The guard that makes a silently missing architecture a red build rather
  // than a checksum file covering half the release.
  it("composes SHA256SUMS with --expect 2", () => {
    expect(workflow).toContain("compose-core-shasums.mjs --dir core-tarballs --expect 2");
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

  // D31. Skipping everywhere is right for a fork and wrong for the repo that
  // tells people to pull from Docker Hub: a release that never reached the
  // primary registry must not report success.
  it("fails a missing Docker Hub credential on the canonical repo only", () => {
    expect(workflow).toContain("actana/control");
    expect(workflow).toMatch(/DOCKERHUB_TOKEN/);
    expect(workflow).toContain("::error title=Missing Docker Hub credential");
  });

  it("pushes the image name the compose file pulls", () => {
    expect(imageWorkflow).toContain(PANEL_IMAGE.split("/").pop());
    expect(imageWorkflow).toContain("ghcr.io");
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

  it("publishes to Docker Hub only when the token is configured", () => {
    // Every Docker Hub step is gated on a non-empty DOCKERHUB_TOKEN, so a repo
    // (or fork) without the secret still releases to GHCR.
    expect(imageWorkflow).toContain('if [[ -n "$DOCKERHUB_TOKEN" ]]');
    expect(imageWorkflow).toContain("docker.io/");
  });

  it("derives the registry namespace instead of hardcoding an owner", () => {
    expect(imageWorkflow).toContain("github.repository_owner");
  });
});

describe("edge workflow", () => {
  it("publishes from main through the same shared image workflow", () => {
    expect(edgeWorkflow).toContain("./.github/workflows/container-image.yml");
    expect(edgeWorkflow).toMatch(/branches:\s*\n\s*- main/);
  });

  it("tags :edge and an immutable per-commit tag, and never moves :latest", () => {
    // Assert on the tags the workflow actually emits, not on the file text —
    // the prose above the trigger says the word "latest" on purpose.
    const tags = edgeWorkflow.match(/^\s*run: echo "tags=(.*?)"/m)?.[1];
    expect(tags).toBe("edge sha-${SHA:0:7}");
    expect(tags).not.toContain("latest");
  });

  it("publishes the Core image alongside the Panel", () => {
    for (const wf of [workflow, edgeWorkflow]) {
      expect(wf).toContain("image: panel");
      expect(wf).toContain("image: core");
    }
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
    expect(built).not.toMatch(/npm (install|i) -g/);
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
    const table = readRepoFile("packages/core/src/actana-container.ts");
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
  for (const image of ["panel", "core"]) {
    it(`${image} has a description file within Docker Hub's 25000-byte limit`, () => {
      const body = readRepoFile(`docs/images/${image}.md`);
      expect(body.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(25_000);
    });
  }

  it("syncs both images, and each short description fits in 100 bytes", () => {
    expect(workflow).toContain("sync panel docs/images/panel.md");
    expect(workflow).toContain("sync core docs/images/core.md");
    for (const [, short] of workflow.matchAll(/^\s+"(.+?)" \|\| rc=1$/gm)) {
      expect(Buffer.byteLength(short, "utf8")).toBeLessThanOrEqual(100);
    }
  });

  // D31/D33. One PAT does both jobs: an OAT can push images but answers
  // "Cannot log into an organization account" on /v2/users/login, so choosing
  // an OAT would mean paying for Team or Business *and still* making a PAT.
  it("authenticates the sync with the same PAT the image push uses", () => {
    const descriptions = workflow.slice(workflow.indexOf("  descriptions:"));
    expect(descriptions).toContain("secrets.DOCKERHUB_TOKEN");
    expect(descriptions).toContain("secrets.DOCKERHUB_USERNAME");
    // The second credential is deleted, everywhere — a secret nothing reads is
    // a secret nobody rotates.
    for (const file of [
      ".github/workflows/release.yml",
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

  it("links the GHCR packages back to this repository", () => {
    // Without image.source the package page has no README at all.
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
