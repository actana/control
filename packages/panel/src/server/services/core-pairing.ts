import { hostname } from "node:os";
import {
  CorePairingError,
  fetchCorePairingIdentity,
  pairWithCore,
  parseCoreAddress,
  type CorePairingFailure,
} from "@actana/sdk/core-pairing";
import { CoreRegistryError, coreRegisteredAt, registerCoreFromCredential } from "./cores";
import {
  pairingFailureMessage,
  type CorePairingFailureCode,
  type CorePairingIdentity,
  type CorePairingRefusal,
  type CorePairingRefusalDetail,
} from "~/shared/core-pairing";
import type { Core } from "~/shared/cores";

/**
 * Adding a Core by short code, on the side of the Panel that can do it (#286).
 *
 * Pairing is Node-side work — an RSA key pair is generated, a TLS chain is read
 * before anything is trusted, a code is spent — so it runs here, next to the
 * other Core-side services, and the renderer posts an address, a fingerprint
 * and a code to it. That is the division the whole file surface already runs
 * on: the Panel server holds the mTLS credentials because no browser can
 * present a client certificate (CONTEXT.md "Dumb pipe", ADR 0030).
 *
 * **There is no second implementation.** The dial, the fingerprint comparison
 * and the redemption are `@actana/sdk/core-pairing` — the same function
 * `actana core pair` calls (#285) — and this module adds an address, a label
 * and a registry write around it. A behaviour that differs between the Panel
 * and the CLI would be a bug in one of them, not a choice.
 *
 * **What this module refuses to say.** Nothing here logs, and nothing here
 * forwards an SDK error message. Both are deliberate: `parsePairingTicket`
 * quotes the string it was given back at the caller, so an SDK message can
 * carry the code an operator typed. Every sentence the browser gets is written
 * from the failure *code* by `~/shared/core-pairing`, so the code, the CSR and
 * the private key have no path into a response body or a log line.
 */

/**
 * What the Core is told this client is called — the Panel, and which host it
 * runs on, because that is what an operator reads in `actana pair ls`.
 *
 * Not the Core's alias in this Panel's registry: that names the machine being
 * added and is the operator's to type. {@link pairCore} keeps the two apart.
 */
export const PANEL_PAIRING_CLIENT_LABEL = `actana-panel ${hostname()}`;

/**
 * Compile-time proof that the browser-facing union is exactly the SDK's.
 *
 * `~/shared/core-pairing` restates the failure list rather than importing it,
 * so that a browser bundle never reaches into a module that opens `node:tls`.
 * This is the seam where the copy is held to the original: a member added,
 * removed or renamed in the SDK fails the Panel's typecheck here, which is the
 * only place that can see both.
 */
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _failureUnionsMatch: SameUnion<CorePairingFailure, CorePairingFailureCode> = true;
void _failureUnionsMatch;

/**
 * A pairing attempt that produced no Core.
 *
 * Carries the whole {@link CorePairingRefusal} rather than only a message: the
 * page switches on `failure` to say what to do next, and a mismatch has to show
 * both fingerprints to be a refusal instead of a shrug. `expose` is the
 * fallback for a path that lets it reach the router's catch-all — the message
 * is already operator-facing and already free of anything secret.
 */
export class CorePairingRefusedError extends Error {
  readonly expose = true;
  readonly refusal: CorePairingRefusal;
  constructor(refusal: CorePairingRefusal) {
    super(refusal.error);
    this.name = "CorePairingRefusedError";
    this.refusal = refusal;
  }
}

/**
 * Dial a Core and report the certificate authority it presents — with no code
 * to send.
 *
 * This is the first half of the two-step the Panel exists to offer: the Panel
 * is the one client that can *show* the operator a fingerprint rather than make
 * them type it into a terminal. Nothing secret has been handed over at this
 * point, and nothing can be, because this call was never given a code.
 */
export async function inspectCoreForPairing(address: string): Promise<CorePairingIdentity> {
  try {
    const identity = await fetchCorePairingIdentity({ address });
    // Deliberately narrower than what the SDK returns: the browser needs a
    // fingerprint to show and an origin to name, and has no use for the CA
    // certificate itself.
    return { fingerprint: identity.fingerprint, httpsOrigin: identity.httpsOrigin };
  } catch (err) {
    throw refusalFrom(err);
  }
}

export type PairCoreInput = {
  /** `host:port`, `https://host:port` or `wss://host:port`. */
  address: string;
  /** The eight-character code, hyphenated or not, in any case. */
  code: string;
  /** The pairing session the code belongs to, when the code does not carry it. */
  sessionId?: string;
  /** The fingerprint the operator confirmed against the presented one. */
  expectedFingerprint: string;
  /** The Panel's alias for the machine. Empty falls back to the endpoint host. */
  label?: string;
};

/**
 * Redeem a code against a Core and register what comes back.
 *
 * The credential the SDK returns is `CoreRegistrationBlob`-shaped with a
 * `clientKey` that was born on this machine and never crossed the wire, so it
 * goes into the registry and the sealed store through
 * {@link registerCoreFromCredential} — the same door a decoded blob walks
 * through today. Nothing downstream can tell the two apart, which is the point:
 * `core-link-manager.ts` dials the result unchanged.
 */
export async function pairCore(input: PairCoreInput): Promise<Core> {
  refuseIfAlreadyRegistered(input.address);

  let credential;
  try {
    credential = await pairWithCore({
      address: input.address,
      code: input.code,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      expectedCaFingerprint: input.expectedFingerprint,
      label: PANEL_PAIRING_CLIENT_LABEL,
      platform: process.platform,
    });
  } catch (err) {
    throw refusalFrom(err);
  }
  // Outside the catch: a registry refusal — an endpoint already spoken for — is
  // the registry's to explain, and wrapping it as a pairing failure would tell
  // the operator to mint a code they do not need.
  return registerCoreFromCredential(credential, { label: input.label ?? "" });
}

/**
 * Refuse a collision this Panel can already see, before the code is spent.
 *
 * A pairing code is one-time. Redeeming it and *then* discovering the endpoint
 * is taken costs the operator that code and leaves the Core holding a signed
 * certificate for a client this Panel never stored — a credential nobody can
 * use and nobody has revoked. The check inside
 * {@link registerCoreFromCredential} still runs and is still the authority,
 * because a Core reports its own endpoint and that need not be the address it
 * was reached on. This one only moves the ordinary case — an operator pairing a
 * machine that is already in the fleet — to before the irreversible step.
 *
 * A bad address falls through to `pairWithCore`, which owns that failure and
 * words it. Nothing here dials, so nothing here is slow.
 */
function refuseIfAlreadyRegistered(address: string): void {
  let endpoint: string;
  try {
    // Via `httpsOrigin` rather than by reassembling host and port: it keeps the
    // brackets an IPv6 authority needs, which a `${host}:${port}` would lose.
    endpoint = `wss://${parseCoreAddress(address).httpsOrigin.slice("https://".length)}`;
  } catch {
    return;
  }
  if (coreRegisteredAt(endpoint)) {
    throw new CoreRegistryError(
      `A Core at ${endpoint} is already registered. Remove it first — your pairing code has not been used.`,
    );
  }
}

/**
 * Turn whatever the SDK threw into the shape the browser is allowed to see.
 *
 * Built field by field rather than by serialising the error: the SDK's message
 * can quote what the caller typed, and `detail` can carry the CA certificate.
 * Neither has any business in a response, so neither is copied.
 */
function refusalFrom(err: unknown): CorePairingRefusedError {
  if (!(err instanceof CorePairingError)) throw err;
  const failure: CorePairingFailureCode = err.failure;
  const detail: CorePairingRefusalDetail = {};
  if (err.detail.expectedFingerprint) detail.expectedFingerprint = err.detail.expectedFingerprint;
  if (err.detail.presentedFingerprint) detail.presentedFingerprint = err.detail.presentedFingerprint;
  if (typeof err.detail.retryAfterSeconds === "number") {
    detail.retryAfterSeconds = err.detail.retryAfterSeconds;
  }
  return new CorePairingRefusedError({
    ...detail,
    failure,
    error: pairingFailureMessage(failure, detail),
  });
}
