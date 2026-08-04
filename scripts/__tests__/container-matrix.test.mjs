import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ARCHES,
  DEFAULT_DISTRO,
  DISTROS,
  INSTALLER_SUITES,
  distroDockerfile,
  imageTag,
  installerMatrix,
  resolveArch,
  resolveDistro,
  suiteScript,
} from "../lib/container-matrix.mjs";

import { captureFailure } from "./capture-failure.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

describe("distros", () => {
  it("resolves every declared distro to a base image", () => {
    for (const distro of DISTROS) {
      expect(resolveDistro(distro.id, () => {}).base).toBe(distro.base);
    }
  });

  it("defaults to the distro the e2es have always run on", () => {
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
    const tags = DISTROS.map((d) => imageTag("install-sh", d.id));
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
});

describe("installer suites", () => {
  it("points every suite at a script that exists", () => {
    for (const suite of INSTALLER_SUITES) {
      expect(fs.existsSync(path.join(repoRoot, suiteScript(suite)))).toBe(true);
    }
  });

  it("covers the whole installer lifecycle — the one-liner and the verbs", () => {
    expect(INSTALLER_SUITES).toContain("install-sh");
    expect(INSTALLER_SUITES).toContain("actana-setup");
  });

  it("crosses every suite with every distro and both architectures", () => {
    const combos = installerMatrix();
    expect(combos).toHaveLength(INSTALLER_SUITES.length * DISTROS.length * ARCHES.length);
    expect(new Set(combos.map((c) => `${c.suite}/${c.distro}/${c.arch}`)).size).toBe(combos.length);
  });
});

// The matrix is only real if CI runs it. These read the workflow rather than
// trusting that whoever added a distro remembered to widen the job.
describe("the CI workflow runs the declared matrix", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

  /** The `installer-e2e:` job block, up to the next job at the same indent. */
  const job = (() => {
    const start = workflow.indexOf("\n  installer-e2e:");
    expect(start, "ci.yml has no installer-e2e job").toBeGreaterThan(-1);
    const rest = workflow.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next);
  })();

  /** Read an inline matrix axis — `arch: [x64, arm64]` — as a set of values. */
  const axis = (name) => {
    const match = new RegExp(`^\\s+${name}: \\[([^\\]]*)\\]`, "m").exec(job);
    expect(match, `installer-e2e has no inline \`${name}:\` matrix axis`).not.toBeNull();
    return new Set(match[1].split(",").map((value) => value.trim()));
  };

  it("crosses the same distros the module declares", () => {
    expect(axis("distro")).toEqual(new Set(DISTROS.map((d) => d.id)));
  });

  it("crosses the same architectures the module declares", () => {
    expect(axis("arch")).toEqual(new Set(ARCHES.map((a) => a.id)));
  });

  it("crosses the same suites the module declares", () => {
    expect(axis("suite")).toEqual(new Set(INSTALLER_SUITES));
  });

  it("maps each architecture to the runner and tarball target the module names", () => {
    for (const arch of ARCHES) {
      const include = new RegExp(
        `- arch: ${arch.id}\\n(?:\\s+\\w+: .*\\n)*?\\s+runner: ${arch.runner}\\b`,
      );
      expect(include.test(job), `installer-e2e does not run ${arch.id} on ${arch.runner}`).toBe(
        true,
      );
      expect(job).toMatch(new RegExp(`target: ${arch.target}\\b`));
    }
  });

  it("runs the legs in parallel and lets each one report — matrix runtime stays reasonable", () => {
    expect(job).toMatch(/fail-fast: false/);
  });

  it("reuses the built tarballs rather than rebuilding them per leg", () => {
    expect(job).toMatch(/download-artifact/);
    expect(job).not.toMatch(/pnpm core:tarball\b/);
  });

  it("builds a tarball for every architecture the matrix consumes", () => {
    const start = workflow.indexOf("\n  core-tarball-smoke:");
    expect(start, "ci.yml has no core-tarball-smoke job").toBeGreaterThan(-1);
    const rest = workflow.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const tarballJob = next === -1 ? rest : rest.slice(0, next);

    for (const arch of ARCHES) {
      const include = new RegExp(
        `- runner: ${arch.runner}\\n(?:\\s+\\w+: .*\\n)*?\\s+target: ${arch.target}\\b`,
      );
      expect(
        include.test(tarballJob),
        `no ${arch.target} tarball is built on ${arch.runner} for the matrix to download`,
      ).toBe(true);
    }
  });
});
