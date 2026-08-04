import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PANEL_DATA_DIR,
  PANEL_DOCKERFILE,
  PANEL_IMAGE,
  PANEL_PORT,
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
const coreDockerfile = readRepoFile("deploy/dev/core.Dockerfile");

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

  it("builds and runs on the exact Node CI tests against", () => {
    const ciNode = readRepoFile(".github/workflows/ci.yml").match(/node-version:\s*(\S+)/)?.[1];
    expect(ciNode).toBeTruthy();
    for (const { image } of dockerfile.froms) {
      expect(image).toMatch(new RegExp(`^node:${ciNode.replace(/\./g, "\\.")}-`));
    }
  });

  it("is multi-stage with a slim runtime — build toolchains stay out of the shipped image", () => {
    expect(dockerfile.froms.length).toBeGreaterThan(1);
    expect(dockerfile.froms.at(-1).image).toContain("-slim");
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

  it("runs as the unprivileged node user", () => {
    expect(dockerfile.users.at(-1)).toBe("node");
  });

  it("starts the same entry the bare-node path documents", () => {
    expect(dockerfile.cmd).toContain("bin/panel.mjs");
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

// The Core image is deploy/dev's Core-in-a-box — a development fixture, now
// published under a production-looking name. These tests are what keeps that
// distinction from quietly eroding.
describe("core image", () => {
  it("is built from the dev Core-in-a-box Dockerfile", () => {
    expect(imageWorkflow).toContain("deploy/dev/core.Dockerfile");
  });

  it("supplies the Core tarball as a named build context", () => {
    // artifacts/ is excluded by .dockerignore, so the tarball cannot ride in
    // on the main context — core.Dockerfile COPYs it `--from=tarball`.
    expect(coreDockerfile).toContain("COPY --from=tarball");
    expect(imageWorkflow).toContain("--build-context tarball=artifacts/core");
    expect(imageWorkflow).toContain("pnpm core:tarball");
  });

  it("labels itself a development fixture", () => {
    expect(imageWorkflow).toContain("ai.actana.image.role=development-fixture");
    expect(imageWorkflow).toMatch(/org\.opencontainers\.image\.description=.*NOT a production deployment/);
  });

  it("is smoked for the tarball and the first-boot unit before it is pushed", () => {
    expect(imageWorkflow).toContain("core-provision.service");
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
