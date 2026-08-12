// Reaching a Core, for `actana core status`.
//
// The whole of this package's use of the SDK, on purpose. `core status` is the
// one verb in the `core` noun that leaves the machine — `add`, `ls`, `use` and
// `rm` are registry operations and dial nothing — so the dialling lives behind
// one function that the command takes as a dependency. That is what lets the
// noun's surface (flags, output, exit codes, `--json` shape) be exercised
// without a Core, and what keeps "the CLI is an SDK consumer" a one-file claim
// rather than an assumption spread across the command tree.
//
// It is also the seam #129's later tickets widen: `session`, `project`,
// `harness` and `events` are all "connect, ask, print", and they will each want
// the client this builds rather than a second way of building one.

import { CoreClient } from "@actana/sdk/core-client.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";

/** What one round trip to a Core tells you about it. */
export type CoreProbe = {
  /** The Core's own id, off `authOk`. */
  coreId: string | null;
  /**
   * The core-link protocol version off `ready` — **the version a Core reports
   * over the link.** A Core does not announce its package version on the wire
   * (`ready` carries the protocol version and the capability set, and nothing
   * else), so this is what "reports its version" means for a client that has
   * only a socket. It is also the more useful of the two: it is the number that
   * decides whether this client and that Core can speak at all.
   */
  protocolVersion: string | null;
  /** Whether this build speaks that protocol version. */
  compatible: boolean;
  /** Whether the Core announced the multi-connection capability (ADR 0024). */
  multiConnection: boolean;
  /** When this blob's bearer stops being accepted, in epoch ms. */
  bearerExpiresAt: number | null;
};

/** How `core status` reaches a Core. Injected, so the verb is testable. */
export type CoreProbeFn = (
  blob: CoreRegistrationBlob,
  opts: { timeoutMs: number },
) => Promise<CoreProbe>;

/**
 * The real probe: connect, read what the handshake said, hang up.
 *
 * **Read-only and short-lived.** It sends no request frames at all — the
 * `ready` and `authOk` frames a Core opens every connection with already carry
 * everything reported here, so a status check costs one connection and mutates
 * nothing on a machine somebody may be working on. The `close()` is in a
 * `finally` because a client left open holds a socket the Core has to time out.
 */
export const probeCore: CoreProbeFn = async (blob, opts) => {
  const client = CoreClient.fromRegistrationBlob(blob, {
    connectTimeoutMs: opts.timeoutMs,
    requestTimeoutMs: opts.timeoutMs,
  });
  try {
    const info = await client.connect();
    return {
      coreId: info.coreId,
      protocolVersion: info.protocolVersion,
      compatible: info.compatible,
      multiConnection: info.multiConnection !== null,
      bearerExpiresAt: info.bearerExpiresAt,
    };
  } finally {
    client.close();
  }
};
