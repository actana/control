import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ARCHES,
  DEFAULT_DISTRO,
  DISTROS,
  E2E_SCRIPT,
  TRIGGERS,
  archesFor,
  distroDockerfile,
  imageTag,
  installerMatrix,
  resolveArch,
  resolveDistro,
} from "../lib/container-matrix.mjs";

import { captureFailure } from "./capture-failure.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

describe("distros", () => {
  it("resolves every declared distro to a base image", () => {
    for (const distro of DISTROS) {
      expect(resolveDistro(distro.id, () => {}).base).toBe(distro.base);
    }
  });

  it("defaults to the distro the e2e has always run on", () => {
    expect(resolveDistro(undefined, () => {}).id).toBe(DEFAULT_DISTRO);
    expect(DISTROS.some((d) => d.id === DEFAULT_DISTRO)).toBe(true);
  });

  it("covers more than one distribution — a one-distro matrix is not a matrix", () => {
    expect(DISTROS.length).toBeGreaterThan(1);
    expect(new Set(DISTROS.map((d) => d.base)).size).toBe(DISTROS.length);
  });

  it("names the choices when asked for a distro it does not have", () => {
    const message = captureFailure((fail) => resolveDistro("alpine", fail));
    expect(message).toMatch(/alpine/);
    for (const distro of DISTROS) expect(message).toContain(distro.id);
  });

  it("builds each distro's image from its own base", () => {
    for (const distro of DISTROS) {
      const dockerfile = distroDockerfile(distro.id, { fail: () => {} });
      expect(dockerfile).toContain(`FROM ${distro.base}`);
      // The no-sudo guarantee is what makes "installs without root" testable;
      // it has to survive the base image swap.
      expect(dockerfile).toContain("purge -y --auto-remove sudo");
    }
  });

  it("passes extra packages through to every distro's image", () => {
    for (const distro of DISTROS) {
      const dockerfile = distroDockerfile(distro.id, { packages: ["curl"], fail: () => {} });
      expect(dockerfile).toMatch(/\bcurl\b/);
    }
  });

  it("gives each distro its own image tag, so one run cannot reuse another's image", () => {
    const tags = DISTROS.map((d) => imageTag("installer", d.id));
    expect(new Set(tags).size).toBe(DISTROS.length);
    for (const tag of tags) expect(tag).toMatch(/^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9._-]+$/);
  });
});

describe("architectures", () => {
  it("covers both Linux architectures the release ships", () => {
    expect(ARCHES.map((a) => a.target).sort()).toEqual(["linux-arm64", "linux-x64"]);
  });

  it("runs arm64 on an arm runner — a cross-built leg would prove nothing", () => {
    expect(resolveArch("arm64", () => {}).runner).toMatch(/-arm$/);
    expect(resolveArch("x64", () => {}).runner).not.toMatch(/-arm$/);
  });

  it("names the choices when asked for an architecture it does not have", () => {
    const message = captureFailure((fail) => resolveArch("riscv64", fail));
    expect(message).toMatch(/riscv64/);
    for (const arch of ARCHES) expect(message).toContain(arch.id);
  });

  it("gives every architecture a trigger, and every trigger a leg (ADR 0016 D36)", () => {
    for (const arch of ARCHES) expect(TRIGGERS).toContain(arch.trigger);
    for (const trigger of TRIGGERS) expect(archesFor(trigger).length).toBeGreaterThan(0);
  });

  it("keeps x64 on the PR and moves arm64 to the tag run", () => {
    expect(archesFor("pr").map((a) => a.id)).toEqual(["x64"]);
    expect(archesFor("tag").map((a) => a.id)).toEqual(["arm64"]);
  });
});

describe("the installer e2e", () => {
  it("points at a script that exists", () => {
    expect(fs.existsSync(path.join(repoRoot, E2E_SCRIPT))).toBe(true);
  });

  // ADR 0016 D36: the one-liner is the entry point of this script, not a suite
  // of its own. A second `e2e-*-linux.mjs` installer script reintroduces the
  // duplicated install phase and the extra container boot per leg that merging
  // them removed.
  it("is the only installer e2e — the one-liner is its entry point, not a suite", () => {
    expect(fs.existsSync(path.join(repoRoot, "scripts/e2e-install-sh-linux.mjs"))).toBe(false);
    const source = fs.readFileSync(path.join(repoRoot, E2E_SCRIPT), "utf8");
    expect(source).toMatch(/curl -fsSL \$\{url\}\/install\.sh \| bash/);
  });

  it("crosses every distro with the architectures each trigger runs", () => {
    for (const trigger of TRIGGERS) {
      const combos = installerMatrix(trigger);
      expect(combos).toHaveLength(DISTROS.length * archesFor(trigger).length);
      expect(new Set(combos.map((c) => `${c.distro}/${c.arch}`)).size).toBe(combos.length);
      for (const combo of combos) expect(combo.script).toBe(E2E_SCRIPT);
    }
  });
});

// The matrix is only real if the workflows run it. These read the workflow
// files rather than trusting that whoever added a distro remembered to widen
// the jobs.
describe("the workflows run the declared matrix", () => {
  const workflow = (file) => fs.readFileSync(path.join(repoRoot, ".github/workflows", file), "utf8");

  /** One job block, from its key up to the next job at the same indent. */
  const jobBlock = (source, name) => {
    const start = source.indexOf(`\n  ${name}:`);
    expect(start, `no ${name} job`).toBeGreaterThan(-1);
    const rest = source.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  /** Read an inline matrix axis — `arch: [x64]` — as a set of values. */
  const axis = (job, name) => {
    const match = new RegExp(`^\\s+${name}: \\[([^\\]]*)\\]`, "m").exec(job);
    expect(match, `the job has no inline \`${name}:\` matrix axis`).not.toBeNull();
    return new Set(match[1].split(",").map((value) => value.trim()));
  };

  const ci = workflow("ci.yml");
  const release = workflow("core-release.yml");
  const jobs = {
    pr: jobBlock(ci, "installer-e2e"),
    tag: jobBlock(release, "installer-e2e"),
  };

  it.each(TRIGGERS)("crosses the same distros the module declares (%s)", (trigger) => {
    expect(axis(jobs[trigger], "distro")).toEqual(new Set(DISTROS.map((d) => d.id)));
  });

  it.each(TRIGGERS)("runs exactly the architectures declared for it (%s)", (trigger) => {
    expect(axis(jobs[trigger], "arch")).toEqual(new Set(archesFor(trigger).map((a) => a.id)));
  });

  it.each(TRIGGERS)("maps each architecture to its runner and tarball target (%s)", (trigger) => {
    for (const arch of archesFor(trigger)) {
      const include = new RegExp(
        `- arch: ${arch.id}\\n(?:\\s+\\w+: .*\\n)*?\\s+runner: ${arch.runner}\\b`,
      );
      expect(include.test(jobs[trigger]), `${arch.id} does not run on ${arch.runner}`).toBe(true);
      expect(jobs[trigger]).toMatch(new RegExp(`target: ${arch.target}\\b`));
    }
  });

  it.each(TRIGGERS)("runs the one merged script, not a per-suite one (%s)", (trigger) => {
    expect(jobs[trigger]).toContain(E2E_SCRIPT);
  });

  it.each(TRIGGERS)("lets each leg report — one red distro is the signal (%s)", (trigger) => {
    expect(jobs[trigger]).toMatch(/fail-fast: false/);
  });

  it("reuses the built tarballs rather than rebuilding them per leg", () => {
    for (const trigger of TRIGGERS) {
      expect(jobs[trigger]).toMatch(/download-artifact/);
      expect(jobs[trigger]).not.toMatch(/pnpm core:tarball\b/);
    }
  });

  it("builds a tarball on every PR for the architecture the PR matrix consumes", () => {
    const tarballJob = jobBlock(ci, "core-tarball-smoke");
    for (const arch of archesFor("pr")) {
      const include = new RegExp(
        `- runner: ${arch.runner}\\n(?:\\s+\\w+: .*\\n)*?\\s+target: ${arch.target}\\b`,
      );
      expect(
        include.test(tarballJob),
        `no ${arch.target} tarball is built on ${arch.runner} for the matrix to download`,
      ).toBe(true);
    }
  });

  // arm64's installer leg only moves to the tag run honestly if the PR still
  // boots an arm64 tarball on arm64 hardware — that is what pays for not
  // running the container matrix there.
  it("still boots the arm64 tarball natively on every PR", () => {
    const tarballJob = jobBlock(ci, "core-tarball-smoke");
    for (const arch of archesFor("tag")) {
      expect(tarballJob).toMatch(new RegExp(`runner: ${arch.runner}\\n\\s+target: ${arch.target}\\b`));
    }
    expect(tarballJob).toContain("smoke-core-tarball.mjs");
  });

  it("gates the release on the tag-run legs — an uninstallable asset is not a release", () => {
    expect(jobBlock(release, "publish")).toMatch(/needs: \[[^\]]*installer-e2e[^\]]*\]/);
  });
});
