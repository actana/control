// Shared machinery for the `actana setup` end-to-end tests.
//
// The Linux e2e (systemd, in a privileged container) and the macOS one
// (launchd, on the host) assert the same acceptance criteria against two
// different init systems. What they legitimately share is everything that is
// not the init system: running a command, polling until something is true,
// waiting for the daemon's port, and picking the pairing token out of setup's
// output. Those live here so the two scripts differ only where the platforms
// actually differ.
//
// `scripts/lib/core-smoke.mjs` stays the home for the tarball smoke's own
// helpers — spawning the Core and dialling it. This module never spawns a
// Core; it drives an installed one.

import { spawnSync } from "node:child_process";
import * as net from "node:net";

import { decodeBlob } from "./core-smoke.mjs";

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

/**
 * Pull the pairing token out of a verb's output.
 *
 * The token is identified by decoding rather than by position: setup prints
 * prose around it, and matching "the long line" would silently start passing
 * on the wrong line the day the output grows a second long one.
 */
export function extractPairingToken(stdout, context, die) {
  for (const line of stdout.split("\n").map((l) => l.trim())) {
    if (line.length < 100) continue;
    try {
      return { raw: line, blob: decodeBlob(line) };
    } catch {
      /* not the token line */
    }
  }
  die(`no pairing token in the output of ${context}`, stdout.split("\n"));
}
