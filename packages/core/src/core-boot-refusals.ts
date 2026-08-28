// What a Core refuses to boot on, and why — the two environment shapes that
// used to start a daemon nobody could trust (#348).
//
// Both are the same class of failure: an environment left by a *previous
// generation* of this product, read by a daemon that no longer means the same
// thing by it. The daemon's own answer to that has to be a refusal, because
// the alternative is not a broken Core — it is a Core that boots, listens, and
// is wrong in a way no operator can see from the outside.
//
// Pure: an environment in, a sentence or null out. Nothing here reads a disk,
// a clock or a socket, which is what lets `core-boot-refusals.test.ts` prove
// the refusals without starting a daemon or binding a port.

/** The prefix every variable a pre-rename install set carries. */
export const LEGACY_ENV_PREFIX = "AC_HARNESS_";

/**
 * Hosts that mean "this machine only" — the addresses loopback mode assumes.
 *
 * An empty value is loopback too: `core-entry` defaults the bind address to
 * `127.0.0.1`, so a variable that is unset or blank is the default, not a
 * different answer. `::` and `0.0.0.0` are deliberately absent — they are the
 * wildcard bind that {@link plaintextExposureRefusal} exists to catch.
 */
const LOOPBACK_HOSTS = new Set(["", "127.0.0.1", "::1", "[::1]", "localhost"]);

/** Whether a bind address reaches no further than this machine. */
export function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  // The whole of `127.0.0.0/8` is loopback, not just `127.0.0.1`, and a
  // machine that binds `127.0.0.2` has still bound itself and nothing else.
  return LOOPBACK_HOSTS.has(trimmed) || /^127\.\d+\.\d+\.\d+$/.test(trimmed);
}

/** Every `AC_HARNESS_*` variable set in an environment, sorted for a stable message. */
export function legacyEnvVars(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith(LEGACY_ENV_PREFIX))
    .sort();
}

/**
 * Refuse an environment written for the Harness-era daemon (#348).
 *
 * The pre-rename LaunchAgent sets `AC_HARNESS_REMOTE`, `AC_HARNESS_PUBLIC_HOST`
 * and `AC_HARNESS_MATERIAL_FILE`; only `AC_CORE_LINK_PORT`, `AC_CORE_LINK_HOST`
 * and `AC_USER_DATA_DIR` kept their names across the rename. This daemon reads
 * the `AC_CORE_` spellings and nothing else, so under the old plist every one
 * of those three simply *is not there*: no remote mode, no public host, no
 * material file.
 *
 * That is not a degraded boot, it is a different product. `AC_HARNESS_REMOTE=1`
 * silently becomes loopback mode — plain `ws://`, no TLS, no client cert, no
 * bearer — while `AC_CORE_LINK_HOST` still carries the old plist's `0.0.0.0`
 * and `AC_CORE_LINK_PORT` its 8443. The daemon that results serves an
 * unauthenticated plaintext core-link on every interface of the machine, and
 * the only symptom an operator sees is that TLS clients fail at the wire with
 * `wrong version number` — which reads as a broken certificate, not as an open
 * door.
 *
 * So the boot stops, and the message names the rename rather than the
 * variable: an operator staring at `AC_HARNESS_REMOTE` needs told that the
 * agent setting it is the thing to remove, and that `actana setup` is what
 * removes it.
 */
export function legacyEnvRefusal(env: NodeJS.ProcessEnv): string | null {
  const found = legacyEnvVars(env);
  if (found.length === 0) return null;
  const one = found.length === 1;
  return (
    `${found.join(", ")} ${one ? "is" : "are"} set. ${one ? "That variable belongs" : "Those variables belong"} ` +
    "to the Harness-era daemon, which this one is the rename of — it reads the `AC_CORE_` " +
    `spellings and would ignore ${one ? "it" : "every one of them"}, boot without TLS, without a client ` +
    "certificate and without a bearer, and serve that on whatever address the same " +
    `environment named. It will not do that. The service setting ${one ? "it" : "them"} is an auto-start ` +
    "unit or LaunchAgent from before the rename (`com.actana.harness` on macOS, " +
    "`actana-harness.service` on Linux): run `actana setup` to remove it and register " +
    "this Core properly."
  );
}

/**
 * Refuse a plaintext core-link on an address other than this machine (#348).
 *
 * Loopback mode is the trusted-transport mode: no TLS, no client certificate,
 * no bearer, because the only thing that can reach the socket is a process on
 * the same machine. Bind that same server to `0.0.0.0` and every one of those
 * assumptions is false, with nothing in the protocol left to notice — and this
 * is not a hypothetical shape, it is exactly what a pre-rename plist produces
 * once its `AC_HARNESS_REMOTE=1` stops being read.
 *
 * Refused rather than logged. A warning is the right weight for something an
 * operator can weigh up; an unauthenticated shell service on every interface of
 * the machine is not that, and a line in a log file nobody tails is not consent.
 * The two ways out are both one command: bind loopback, or run a real remote
 * Core with `actana setup`, which mints the material and sets `AC_CORE_REMOTE`.
 */
export function plaintextExposureRefusal(opts: {
  remoteMode: boolean;
  host: string;
}): string | null {
  if (opts.remoteMode || isLoopbackHost(opts.host)) return null;
  return (
    `AC_CORE_LINK_HOST is ${opts.host} but AC_CORE_REMOTE is not set. In loopback mode the ` +
    "core-link server is plain `ws://` and trusts every connection — no TLS, no client " +
    "certificate, no bearer — because only this machine can reach it. On " +
    `${opts.host} that is not true: it would serve an unauthenticated Core, able to start ` +
    "processes and read this machine's files, to anything that can route to it. Bind " +
    "127.0.0.1, or run a real remote Core — `actana setup` mints the material and sets " +
    "AC_CORE_REMOTE=1."
  );
}
