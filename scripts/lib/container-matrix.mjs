// The shape of the containerised installer matrix, in one place.
//
// Two axes decide what "the installer works on Linux" means:
//
//   • the distribution — the init system, PAM stack and polkit rules an
//     operator's machine actually ships, which is where sudo-less `systemctl
//     --user` and `loginctl enable-linger` differ between distros;
//   • the architecture — the release ships linux-x64 and linux-arm64 tarballs
//     with prebuilt natives, and a tarball that only runs on the architecture
//     it was built on is a tarball half our operators cannot use. Both are
//     covered; they are covered on different triggers, which is what `trigger`
//     on each entry of `ARCHES` says and why.
//
// There is no suite axis. ADR 0016 D36 folded the one-liner into the setup e2e
// as its entry point, so one script covers the whole install story: `curl … |
// bash` against the fixture release server, then the lifecycle assertions on
// the machine it produced.
//
// The e2e script reads this to know what image to build; the CI and release
// workflows cross the same axes; and `container-matrix.test.mjs` reads all of
// them, so a distro added here and forgotten in `.github/workflows/ci.yml` is a
// failing test rather than a leg nobody notices is missing.

import { stringFlag } from "./cli.mjs";
import { systemdDockerfile } from "./systemd-container.mjs";

/**
 * The distributions the installer is tested on.
 *
 * Both are Debian-family on purpose: `systemdDockerfile` is apt-based, and the
 * pair that matters for v1 is "the LTS everyone provisions" against "the
 * upstream it derives from, with a newer systemd and polkit". An RPM distro
 * would need its own Dockerfile builder and is a later widening, not a
 * cheaper one.
 */
export const DISTROS = [
  { id: "ubuntu", base: "ubuntu:24.04", label: "Ubuntu 24.04" },
  { id: "debian", base: "debian:trixie", label: "Debian 13" },
];

/** What an e2e run with no `--distro` uses. */
export const DEFAULT_DISTRO = "ubuntu";

/** When a leg runs: on every pull request, or only on a release tag. */
export const TRIGGERS = ["pr", "tag"];

/**
 * The Linux architectures the matrix covers, where each one runs, and when.
 *
 * `runner` is a GitHub-hosted label: arm64 legs run natively on arm hardware
 * because the thing under test is a tarball of prebuilt native modules, and
 * emulating it would test qemu instead.
 *
 * `trigger` is why the PR matrix is two legs and not four (ADR 0016 D36). The
 * arch-sensitive risk here is prebuilt natives, and `core-tarball-smoke`
 * already boots the arm64 tarball on an arm64 runner every PR; what only this
 * matrix can catch — PAM, polkit, logind — varies by distro, not by
 * architecture. So arm64's installer leg moves to the tag run, where the cost
 * is paid once per release instead of once per push.
 */
export const ARCHES = [
  { id: "x64", runner: "ubuntu-24.04", target: "linux-x64", trigger: "pr" },
  { id: "arm64", runner: "ubuntu-24.04-arm", target: "linux-arm64", trigger: "tag" },
];

/** The one script the matrix runs — the installer e2e, entered at the one-liner. */
export const E2E_SCRIPT = "scripts/e2e-actana-setup-linux.mjs";

/** Look up a distro by id, failing with the ids that do exist. */
export function resolveDistro(id = DEFAULT_DISTRO, fail) {
  const found = DISTROS.find((distro) => distro.id === id);
  if (!found) {
    fail(`unknown distro ${JSON.stringify(id)} — try one of: ${DISTROS.map((d) => d.id).join(", ")}`);
    return DISTROS[0];
  }
  return found;
}

/** Look up an architecture by id, failing with the ids that do exist. */
export function resolveArch(id, fail) {
  const found = ARCHES.find((arch) => arch.id === id);
  if (!found) {
    fail(`unknown arch ${JSON.stringify(id)} — try one of: ${ARCHES.map((a) => a.id).join(", ")}`);
    return ARCHES[0];
  }
  return found;
}

/** The architectures whose installer legs run on `trigger`. */
export function archesFor(trigger) {
  return ARCHES.filter((arch) => arch.trigger === trigger);
}

/**
 * Read `--distro` off parsed argv, resolved.
 *
 * A bare `--distro` (no value) is a mistake worth failing on rather than
 * silently running the default one, which is what `stringFlag` is for.
 */
export function distroFlag(args, fail) {
  return resolveDistro(stringFlag(args, "distro", fail, DEFAULT_DISTRO), fail);
}

/**
 * A distro-specific image tag.
 *
 * The distro is in the tag rather than only in the Dockerfile because Docker
 * caches by tag: without it, a debian run would happily reuse the ubuntu image
 * built a minute earlier and report a pass for a machine it never booted.
 */
export function imageTag(purpose, distroId) {
  return `actana-${purpose}-${distroId}:latest`;
}

/** The systemd Dockerfile for a distro, with any extra packages it needs. */
export function distroDockerfile(distroId, { packages = [], fail } = {}) {
  const distro = resolveDistro(distroId, fail);
  return systemdDockerfile({ base: distro.base, packages });
}

/** Every (distro, arch) leg the given trigger runs. */
export function installerMatrix(trigger = "pr") {
  return archesFor(trigger).flatMap((arch) =>
    DISTROS.map((distro) => ({
      distro: distro.id,
      arch: arch.id,
      runner: arch.runner,
      target: arch.target,
      script: E2E_SCRIPT,
    })),
  );
}
