import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CORE_APP_ROOT,
  CORE_HOME,
  CORE_PACKAGES,
  CORE_PORT,
  PANEL_DATA_DIR,
  PANEL_DOCKERFILE,
  PANEL_IMAGE,
  PANEL_PORT,
  PANEL_RUNTIME_USER,
  aptPackages,
  composeFacts,
  dockerfileFacts,
  readRepoFile,
  repoRoot,
} from "../lib/panel-image.mjs";

// The one-deployable contract (web-panel-extraction issue 09): the Dockerfile,
// the reference compose, the Caddyfile, and the release workflow are separate
// files that must agree on the image name, the port, and the single data
// directory. These tests are the agreement.

const dockerfile = dockerfileFacts(readRepoFile(PANEL_DOCKERFILE));
const compose = composeFacts(readRepoFile("deploy/docker-compose.yml"));
const caddyfile = readRepoFile("deploy/Caddyfile");
const workflow = readRepoFile(".github/workflows/images-release.yml");
// The build/smoke/push machinery moved into one reusable workflow so the PR,
// edge, and release paths share a single implementation; images-release.yml is
// now only the version-tag half. Assertions follow the code.
const imageWorkflow = readRepoFile(".github/workflows/container-image.yml");
const edgeWorkflow = readRepoFile(".github/workflows/images-edge.yml");
const coreDockerfile = readRepoFile("deploy/core.Dockerfile");
const core = dockerfileFacts(coreDockerfile);

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
    expect(readRepoFile("deploy/dev/docker-compose.yml")).toContain(
      `dockerfile: ${PANEL_DOCKERFILE}`,
    );
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
  // toolchain — which is where 174 of the 192 CVEs went. Pinned by digest
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
    expect(dockerfile.healthcheck).toContain("/nodejs/bin/node");
    expect(dockerfile.healthcheck).toMatch(/CMD\s*\[/);
    expect(dockerfile.healthcheck).toContain("/api/healthz");
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
    expect(readRepoFile("scripts/smoke-panel-image.mjs")).toContain("Config.Healthcheck");
    // And again on the published multi-arch manifest, which is a different
    // artifact from the per-arch image the smoke ran against.
    expect(imageWorkflow).toContain("Healthcheck");
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

describe("reference compose", () => {
  const panel = compose.services.panel;
  const caddy = compose.services.caddy;

  it("runs the published Panel image", () => {
    expect(panel.image).toBe(`${PANEL_IMAGE}:latest`);
  });

  it("publishes no Panel port — the proxy is the only way in from outside", () => {
    expect(panel.ports).toEqual([]);
  });

  it("mounts exactly one named volume, at the image's data directory", () => {
    expect(panel.volumes).toEqual([`panel-data:${PANEL_DATA_DIR}`]);
    expect(compose.volumes).toContain("panel-data");
  });

  it("passes AC_SECRETS_KEY through so the key can live outside the volume", () => {
    expect(panel.environment.some((e) => e.startsWith("AC_SECRETS_KEY="))).toBe(true);
  });

  it("terminates TLS in Caddy on 80/443 with persistent cert storage", () => {
    expect(caddy.ports).toEqual(expect.arrayContaining(["80:80", "443:443"]));
    expect(caddy.volumes.some((v) => v.includes("Caddyfile"))).toBe(true);
    expect(caddy.volumes.some((v) => v.startsWith("caddy-data:"))).toBe(true);
    expect(compose.volumes).toContain("caddy-data");
  });

  it("proxies to the port the image exposes, for the domain the operator sets", () => {
    expect(caddyfile).toContain("{$AC_PANEL_DOMAIN}");
    expect(caddyfile).toContain(`reverse_proxy panel:${PANEL_PORT}`);
  });

  it("documents the two env knobs the compose path needs", () => {
    const example = readRepoFile("deploy/.env.example");
    expect(example).toContain("AC_PANEL_DOMAIN");
    expect(example).toContain("AC_SECRETS_KEY");
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
  it("is built from deploy/core.Dockerfile, not the dev fixture", () => {
    // deploy/dev/ still exists until T45 deletes it; what matters here is that
    // the published image stopped coming from it.
    expect(imageWorkflow).toContain("deploy/core.Dockerfile");
    expect(imageWorkflow).not.toContain("deploy/dev/core.Dockerfile");
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
    expect(core.froms).toHaveLength(1);
    expect(core.froms[0].image).toMatch(/^ubuntu:24\.04@sha256:[0-9a-f]{64}$/);
  });

  it("upgrades in the same RUN layer that installs, not a later one", () => {
    const install = core.runs.filter((run) => run.includes("apt-get install"));
    expect(install).toHaveLength(1);
    expect(install[0]).toMatch(/apt-get update.*apt-get upgrade -y.*apt-get install/s);
  });

  // D6 — the package set is the whole CVE story, so it is asserted exactly.
  it("installs the agreed package set and nothing else", () => {
    const install = core.runs.find((run) => run.includes("apt-get install"));
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
    expect(core.args.NODE_VERSION).toMatch(/^24\./);
    const install = core.runs.find((run) => run.includes("nodejs.org"));
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
    const account = core.runs.find((run) => run.includes("useradd"));
    expect(account).toContain("userdel");
    expect(account).toMatch(/groupadd --gid 1000 core/);
    expect(account).toMatch(/useradd --uid 1000 --gid 1000/);
    expect(core.users.at(-1)).toBe("core");
  });

  it("gives NOPASSWD sudo to core and to nobody else", () => {
    const sudoers = core.runs.filter((run) => run.includes("NOPASSWD"));
    expect(sudoers).toHaveLength(1);
    expect(sudoers[0]).toContain("core ALL=(ALL) NOPASSWD:ALL");
    expect(sudoers[0]).toContain("/etc/sudoers.d/core");
  });

  // D14 — tini is PID 1 so reparented Harnesses get reaped; baked in, because
  // `--init` is opt-in and a bare `docker run` would skip it.
  it("runs the daemon under tini as PID 1", () => {
    expect(core.entrypoint).toBe('["/usr/bin/tini", "--"]');
    expect(core.cmd).toBe('["actana", "daemon"]');
  });

  // D15 — the operator contract is three ACTANA_* variables; everything here
  // is a private image constant the container mode depends on.
  it("bakes the container-mode environment", () => {
    expect(core.env).toMatchObject({
      ACTANA_CONTAINER: "1",
      AC_CORE_REMOTE: "1",
      AC_CORE_LINK_HOST: "0.0.0.0",
      AC_APP_PATH: `${CORE_APP_ROOT}/app`,
      AC_USER_DATA_DIR: `${CORE_HOME}/.local/share/actana/data`,
      AC_CORE_MATERIAL_FILE: `${CORE_HOME}/.config/actana/material.json`,
      NPM_CONFIG_PREFIX: `${CORE_HOME}/.local`,
    });
    expect(core.env.PATH).toContain(`${CORE_APP_ROOT}/bin`);
    expect(core.env.PATH).toContain(`${CORE_HOME}/.local/bin`);
  });

  it("exposes the port from the same ARG as ACTANA_PORT", () => {
    expect(core.args.ACTANA_PORT).toBe(String(CORE_PORT));
    expect(core.env.ACTANA_PORT).toBe("${ACTANA_PORT}");
    expect(core.exposesRaw).toEqual(["${ACTANA_PORT}"]);
  });

  // D9 — ~1.15 GB of the ~1.4 GB a baked image would weigh, stale within days
  // of a build, and four vendors' binaries nobody has licence-cleared.
  // Asserted against the instructions, not the file text: the comments name
  // every one of these on purpose, to say why it is absent.
  it("bakes no Harnesses", () => {
    const built = core.runs.join("\n");
    for (const harness of ["@anthropic-ai/claude-code", "@openai/codex", "opencode", "cursor"]) {
      expect(built).not.toContain(harness);
    }
    expect(built).not.toMatch(/npm (install|i) -g/);
  });

  it("keeps systemd, and the machine-shaped install, out entirely", () => {
    const built = core.runs.join("\n");
    for (const dead of ["systemd", "loginctl", "linger", "core-provision", "actana setup"]) {
      expect(built).not.toContain(dead);
    }
  });

  it("is smoked before it is pushed", () => {
    expect(imageWorkflow.indexOf("core image smoke OK")).toBeLessThan(
      imageWorkflow.indexOf("Push the per-arch tags"),
    );
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
    const sync = readRepoFile(".github/workflows/dockerhub-description.yml");
    expect(sync).toContain("sync panel docs/images/panel.md");
    expect(sync).toContain("sync core docs/images/core.md");
    for (const [, short] of sync.matchAll(/^\s+"(.+?)" \|\| rc=1$/gm)) {
      expect(Buffer.byteLength(short, "utf8")).toBeLessThanOrEqual(100);
    }
  });

  it("uses a credential distinct from the image-push token", () => {
    // The push token is an org access token; the Hub API refuses org accounts.
    const sync = readRepoFile(".github/workflows/dockerhub-description.yml");
    expect(sync).toContain("DOCKERHUB_DESCRIPTION_TOKEN");
    expect(sync).not.toContain("secrets.DOCKERHUB_TOKEN");
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
