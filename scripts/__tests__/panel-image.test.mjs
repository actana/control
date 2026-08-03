import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PANEL_DATA_DIR,
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

const dockerfile = dockerfileFacts(readRepoFile("Dockerfile"));
const compose = composeFacts(readRepoFile("deploy/docker-compose.yml"));
const caddyfile = readRepoFile("deploy/Caddyfile");
const workflow = readRepoFile(".github/workflows/panel-release.yml");

describe("Dockerfile", () => {
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
    expect(readRepoFile("Dockerfile")).toContain(`npm install -g ${packageManager}`);
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
  it("builds the image on version tags, like the Harness release", () => {
    expect(workflow).toMatch(/tags:\s*\n\s*- "v\*"/);
  });

  it("pushes the image name the compose file pulls", () => {
    expect(workflow).toContain(PANEL_IMAGE.split("/").pop());
    expect(workflow).toContain("ghcr.io");
  });

  it("builds each architecture on a runner of that architecture", () => {
    expect(workflow).toContain("ubuntu-24.04");
    expect(workflow).toContain("ubuntu-24.04-arm");
  });

  it("smokes the image before anything is published", () => {
    expect(workflow).toContain("smoke-panel-image.mjs");
  });

  it("release outputs contain no Electron artifacts", () => {
    const workflowDir = path.join(repoRoot, ".github", "workflows");
    for (const file of fs.readdirSync(workflowDir)) {
      expect(readRepoFile(path.join(".github/workflows", file)).toLowerCase()).not.toContain(
        "electron",
      );
    }
  });
});
