// The choices `scripts/rehearse-install.mjs` makes before it touches Docker.
//
// Separated out because they are the parts that can be wrong quietly: picking
// yesterday's tarball, picking the other architecture's tarball, or printing a
// one-liner that is subtly not the one the docs tell operators to paste. Each
// of those looks like a successful rehearsal right up until a release.

import { resolveArch } from "./container-matrix.mjs";
import { compareVersions, parseAssetName } from "./fixture-release.mjs";

/**
 * The release target the machine running the rehearsal can execute.
 *
 * `process.arch` already uses the same ids `ARCHES` does, so this is a lookup
 * rather than a second copy of the mapping — an architecture added to the
 * matrix becomes rehearsable without touching this file.
 */
export function hostTarget(arch, fail) {
  return resolveArch(arch, (message) =>
    fail(`${message} — the rehearsal can only run a build this machine executes`),
  ).target;
}

/**
 * The newest tarball in `fileNames` built for `target`.
 *
 * Newest by version rather than by mtime: a rehearsal is meant to exercise the
 * release about to go out, and `artifacts/core` accumulates older builds.
 */
export function pickTarball(fileNames, target, fail) {
  const candidates = fileNames
    .map((name) => ({ name, parsed: parseAssetName(name) }))
    .filter((entry) => entry.parsed?.target === target)
    .sort((a, b) => compareVersions(b.parsed.version, a.parsed.version));

  if (candidates.length === 0) {
    fail(
      `no ${target} tarball to rehearse against — run \`pnpm core:tarball\`, ` +
        `or pass --tarball <file>`,
    );
    return null;
  }
  return candidates[0].name;
}

/**
 * The one-liner to paste inside the rehearsal machine.
 *
 * It carries only `--base-url`, and since #316 that is the only kind of flag
 * it *could* carry: install is not activation (ADR 0036 C2), so the script
 * owns four options and refuses the rest. `--yes`, `--with-<harness>` and
 * `--no-harnesses` were never wanted here anyway — the prompts are the whole
 * point of doing this by hand, and they belong to the second command.
 */
export function rehearsalOneLiner(baseUrl) {
  return `curl -fsSL ${baseUrl}/install.sh | bash -s -- --base-url ${baseUrl}`;
}

/**
 * The second command of the rehearsal — the one that turns the machine into a
 * Core, and the one with all the prompts in it.
 *
 * Printed as a hint rather than as gospel: `actana place` prints the runnable
 * form itself, with an absolute path when `~/.local/bin` is not yet on the
 * rehearser's `PATH`, and that printed line is the one to trust. Saying so
 * here is the difference between a rehearsal that stalls at "it installed and
 * nothing happened" and one that carries on.
 */
export function rehearsalSetupCommand() {
  return "actana setup";
}
