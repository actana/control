// Shared machinery for the `actana setup` end-to-end tests.
//
// The Linux e2e (systemd, in a privileged container) and the macOS one
// (launchd, on the host) assert the same acceptance criteria against two
// different init systems. What they legitimately share is everything that is
// not the init system: running a command, polling until something is true, and
// waiting for the daemon's port. Those live here so the two scripts differ only
// where the platforms actually differ.
//
// There used to be a third: picking the pairing token out of setup's output.
// #287 removed the printed token, so what an e2e reads instead is the registry
// entry setup wrote — `credentialFromMaterial` in `core-smoke.mjs` builds the
// dialling half of it.
//
// There is a fourth again since #316, and it is a different kind of thing:
// picking the `actana setup` command out of the *installer's* output. Install
// is not activation (ADR 0036 C2), so an e2e that enters at the one-liner now
// has two steps, and the second one is a command the first one printed.
//
// `scripts/lib/core-smoke.mjs` stays the home for the tarball smoke's own
// helpers — spawning the Core and dialling it. This module never spawns a
// Core; it drives an installed one.

import { spawnSync } from "node:child_process";
import * as net from "node:net";

/**
 * A line that is nothing but an `actana setup` invocation — bare, or through
 * an absolute path when the launcher's directory is not on `PATH`.
 *
 * `[^\S\n]` rather than `[ \t]` because the Linux e2e reads this back through
 * `machinectl shell`, which pipes the session through a PTY and therefore
 * ends every line `\r\n`. A pattern anchored on `[ \t]*$` matches nothing at
 * all there, and it fails as "the installer printed no next command" — a
 * diagnosis that sends the reader to the wrong file.
 */
const SETUP_COMMAND_LINE = /^[^\S\n]*((?:\S*\/)?actana setup)[^\S\n]*$/gm;

/**
 * The `actana setup` command the installer printed, to be run exactly as
 * printed.
 *
 * **Extracted rather than retyped, and that is the point.** #316's criterion
 * is that the printed command is runnable as printed — bare `actana setup`
 * only when this install's own launcher answers to that name and its directory
 * is on `PATH`, and an absolute path otherwise. An e2e that hard-coded
 * `actana setup` would pass on a machine where the printed line was wrong, and
 * fail on one where it was right and the launcher was somebody else's.
 *
 * Exactly one match is required. Zero means the installer stopped saying what
 * to do next; more than one means two copies of a command that are free to
 * disagree, which is the failure the CLI owning the line exists to prevent.
 */
export function nextSetupCommand(stdout, fail) {
  const found = [...String(stdout).matchAll(SETUP_COMMAND_LINE)].map((match) => match[1]);
  if (found.length !== 1) {
    return fail(
      `expected the installer to print exactly one \`actana setup\` command, found ` +
        `${found.length}: ${JSON.stringify(found)}`,
      String(stdout).split("\n"),
    );
  }
  return found[0];
}

/** How long the daemon gets to answer on its port before a test gives up. */
export const LISTEN_TIMEOUT_MS = 60_000;

/** How often {@link until} re-checks. */
const POLL_MS = 1_000;

/** Per-attempt connect timeout when polling a port. */
const CONNECT_TIMEOUT_MS = 2_000;

/**
 * Run a command and capture its output, without throwing.
 *
 * A command that could not be started at all comes back as status 127 with the
 * spawn error as stderr, so callers can treat "not installed" and "exited
 * non-zero" the same way.
 */
export function runCaptured(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    status: result.error ? 127 : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error?.message || ""),
  };
}

/** Poll `check` until it is truthy, or end the test through `die`. */
export async function until(label, timeoutMs, check, die) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) die(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** One connect attempt against a loopback port. */
function tryConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Wait until something accepts connections on a loopback port. */
export async function waitForTcpPort(port, die, timeoutMs = LISTEN_TIMEOUT_MS) {
  await until(`port ${port} to answer`, timeoutMs, () => tryConnect(port), die);
}

