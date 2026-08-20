// Pairing, from the client's side: a key pair born here, a fingerprint checked
// before a secret moves, and a `CoreRegistrationBlob` at the end of it (#280,
// #284).
//
// An operator on the Core runs `actana pair new` and reads out two things — an
// eight-character code and the SHA-256 fingerprint of that Core's CA. This
// module is what the other machine does with them:
//
//   1. dial the Core's HTTPS surface with nothing trusted yet, and read the
//      certificate chain it presents;
//   2. compute the fingerprint of the CA in that chain and compare it with the
//      one the operator read out;
//   3. **only then** post the code, a client label and a CSR;
//   4. put the response together with the private key that never moved, and
//      hand back the shape every other client surface already takes.
//
// **Step 2 is the whole security argument.** A client at step 1 has an address
// and a code and no trust anchor, so the dial cannot verify anything and does
// not pretend to. What it must not do is *stay* that way: the fingerprint is
// compared while nothing secret has been sent, and the redemption in step 3 is
// a second, separate connection pinned to the exact CA certificate that
// matched — `rejectUnauthorized: true`, plus a `checkServerIdentity` that
// re-runs both the hostname check and the fingerprint comparison before the
// handshake completes. There is no code path here that sends the code over an
// unverified connection, and no blob comes back pinned to a CA that was not
// the one compared.
//
// **A caller with no fingerprint is not a caller with a waived one.** Passing
// no `expectedCaFingerprint` is the first-contact case (#286's UI wants to show
// the operator's fingerprint beside the Core's before anyone types anything),
// and it is answered by reporting the presented fingerprint back — through
// {@link fetchCorePairingIdentity}, which has no code to send, or as the
// `fingerprint-unconfirmed` failure of {@link pairWithCore}, which has one and
// does not send it.
//
// **The wire types below are declared here, not imported from
// `@actana/shared`.** The reasoning is `core-registration-blob.ts`'s and it
// applies unchanged: `packages/shared` is private and stays private ([ADR
// 0025][adr] D4), so an SDK that imported the pairing request and response from
// it would be a published package with a dependency nobody outside this
// repository can resolve — the arrangement that ADR rejected (D1: the protocol
// ships with the client). These declarations are structurally identical to what
// `packages/core/src/core-pairing-routes.ts` reads and answers with, and the
// field names are the wire's rather than either side's.
//
// [adr]: ../../docs/adr/0025-the-protocol-ships-with-the-client.md

import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity as checkTlsServerIdentity, connect as tlsConnect } from "node:tls";
import type { DetailedPeerCertificate, PeerCertificate } from "node:tls";
import { generateClientCsr } from "./core-pairing-csr.ts";
import type { CoreRegistrationBlob } from "./core-registration-blob.ts";

// ─── The wire ───

/** The one route a client with no certificate may reach on a Core. */
export const CORE_PAIRING_REDEEM_PATH = "/v1/pair/redeem";

/** What the client says about itself. The Core keeps the label and ignores the rest. */
export type CorePairingClientInfo = {
  /** The machine's own name for itself, e.g. a hostname. */
  label?: string;
  /** `process.platform`, for the operator reading `actana pair ls`. */
  platform?: string;
};

/**
 * The redemption request body.
 *
 * `sessionId` names the pairing session the code belongs to and is not
 * optional: the Core hashes a candidate code together with the session id and
 * refuses to search for a session a code might fit, which is what stops a code
 * lifted from one session being replayed against another.
 */
export type CorePairingRedeemRequest = {
  sessionId: string;
  code: string;
  client: CorePairingClientInfo;
  /** PEM `CERTIFICATE REQUEST`. The private half is not in this object. */
  csr: string;
};

/**
 * The 200 body.
 *
 * Four fields, and the absence of a fifth is the point: there is no key here,
 * because the Core never had one. {@link pairWithCore} supplies the fifth from
 * the key it generated locally.
 */
export type CorePairingRedeemResponse = {
  /** The `wss://host:port` core link to dial from now on. */
  endpoint: string;
  /** PEM CA certificate — the trust anchor for every later dial. */
  caCert: string;
  /** PEM client certificate, signed from the CSR just posted. */
  clientCert: string;
  /** The signed bearer for the `auth` frame. */
  bearer: string;
};

/** A refusal body, as every non-200 answer from the pairing route is shaped. */
export type CorePairingRefusalBody = {
  /** The Core's machine-readable reason, e.g. `pairing-refused`. */
  code?: string;
  /** The human-readable one. */
  error?: string;
};

// ─── Failures ───

/**
 * Why a pairing attempt did not produce a blob.
 *
 * The list is what a caller can *act* on, and it stops where the Core's own
 * answers stop. `refused` covers a wrong code, an expired session, one already
 * redeemed and one whose attempts are spent, because the Core answers all four
 * with one status and one body on purpose (`core-pairing-routes.ts`, "every
 * refusal is the same refusal"): telling them apart on the wire would tell an
 * attacker whether a session exists and whether their last guess was closer.
 * A client that reported four different things would be inventing three of
 * them. The distinction the operator needs is in the Core's audit log, which
 * is where #282 put it deliberately.
 */
export type CorePairingFailure =
  /** The address could not be read as a Core's HTTPS or core-link address. */
  | "bad-address"
  /** The code was not eight characters, or named no pairing session. */
  | "bad-code"
  /** The expected fingerprint was not a SHA-256 fingerprint. */
  | "bad-fingerprint"
  /** Nothing answered at that address, or the dial timed out. */
  | "unreachable"
  /** The Core presented a chain with no CA in it — nothing to pin. */
  | "no-ca-presented"
  /** No fingerprint was given to check against. The code was not sent. */
  | "fingerprint-unconfirmed"
  /** The presented CA is not the expected one. The code was not sent. */
  | "fingerprint-mismatch"
  /**
   * The expected CA, on an address its certificate does not cover.
   *
   * Its own failure rather than a mismatch, because it is not an attack and
   * saying so sends the operator hunting for one: a Core's server certificate
   * covers the host it was set up for plus loopback, so reaching a Core over a
   * second interface, a tunnel or a DNS name added later fails here with the
   * fingerprint matching perfectly.
   */
  | "hostname-mismatch"
  /** The expected CA, and a certificate that is expired or otherwise unusable. */
  | "certificate-invalid"
  /** Wrong, expired, already redeemed, or out of attempts — see above. */
  | "refused"
  /** Too many attempts from this client, too fast. Try again later. */
  | "rate-limited"
  /** The Core would not accept the request itself — a bug on this side. */
  | "rejected"
  /** There is no pairing endpoint on that Core. */
  | "not-pairable"
  /** The Core failed while handling the redemption. */
  | "core-error"
  /** A 200 that was not a redemption response. */
  | "malformed-response";

/** Everything a failure knows beyond its {@link CorePairingFailure}. */
export type CorePairingErrorDetail = {
  /** The HTTP status, when the failure came from one. */
  status?: number;
  /** `retry-after`, in seconds, on a `rate-limited` failure. */
  retryAfterSeconds?: number;
  /** The Core's own refusal code, when it sent one. */
  coreCode?: string;
  /** The fingerprint the caller was told to expect. */
  expectedFingerprint?: string;
  /** The fingerprint the Core actually presented. */
  presentedFingerprint?: string;
  /** The CA the Core presented, PEM — for a UI that wants to show it. */
  presentedCaCert?: string;
  /** The TLS or OpenSSL code behind a dial failure, e.g. `CERT_HAS_EXPIRED`. */
  tlsCode?: string;
};

/**
 * A pairing attempt that did not produce a blob.
 *
 * One class with a {@link CorePairingFailure} rather than a class per failure:
 * the CLI (#285) and the Panel (#286) both switch on the reason to write a
 * sentence, and a `switch` over a union is checked by the compiler where a
 * chain of `instanceof` is not.
 */
export class CorePairingError extends Error {
  override readonly name = "CorePairingError";
  /** Which failure this is. Switch on it; do not read the message. */
  readonly failure: CorePairingFailure;
  /** Whatever the failure knows beyond its reason. */
  readonly detail: CorePairingErrorDetail;

  // Fields are assigned rather than declared as constructor parameters: this
  // package is loaded by plain `node` with nothing but type stripping
  // (`__tests__/plain-node-consumption.test.ts`), and a parameter property is
  // syntax that stripping cannot erase.
  constructor(
    failure: CorePairingFailure,
    message: string,
    detail: CorePairingErrorDetail = {},
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.failure = failure;
    this.detail = detail;
  }
}

// ─── First contact ───

/** What a bootstrap dial learns about a Core before anything is trusted. */
export type CorePairingIdentity = {
  /** SHA-256 over the CA's DER, colon-separated uppercase hex. */
  fingerprint: string;
  /** The PEM CA certificate that fingerprint is of. */
  caCert: string;
  /** The host that was dialled. */
  host: string;
  /** The port that was dialled. */
  port: number;
  /** `https://host:port` — where a redemption would be posted. */
  httpsOrigin: string;
};

/** How long a dial or a redemption may take before it is called unreachable. */
export const DEFAULT_PAIRING_TIMEOUT_MS = 15_000;

/**
 * Dial a Core and report the CA it presents — **without a code to send**.
 *
 * This is the first-contact mode, and the reason it is a separate function
 * rather than a flag is that it takes no code: a UI that shows the operator's
 * fingerprint beside the Core's, and asks a human whether they match, cannot
 * leak a secret it was never given. {@link pairWithCore} calls it too, so the
 * fingerprint a caller confirms is computed by the same code that later
 * enforces it.
 *
 * The dial is unverified, because at this point in the flow there is nothing to
 * verify against — that is what the fingerprint the operator read out is for.
 * Nothing is sent on this connection and it is closed as soon as the chain has
 * been read.
 */
export async function fetchCorePairingIdentity(opts: {
  /** `host:port`, `https://host:port` or `wss://host:port`. */
  address: string;
  /** Defaults to {@link DEFAULT_PAIRING_TIMEOUT_MS}. */
  timeoutMs?: number;
}): Promise<CorePairingIdentity> {
  const { host, port, httpsOrigin } = parseCoreAddress(opts.address);
  const chain = await presentedChain(host, port, opts.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS);
  const ca = certificateAuthorityIn(chain);
  if (!ca) {
    throw new CorePairingError(
      "no-ca-presented",
      `${httpsOrigin} presented a certificate chain with no certificate authority in it, so there is nothing to compare against the fingerprint`,
    );
  }
  return { fingerprint: fingerprintOf(ca.raw), caCert: derToCertificatePem(ca.raw), host, port, httpsOrigin };
}

// ─── Pairing ───

export type PairWithCoreOptions = {
  /** The Core's address: `host:port`, `https://host:port` or `wss://host:port`. */
  address: string;
  /**
   * The pairing code the operator read out — `XXXX-XXXX`, in any case and with
   * or without the hyphen.
   *
   * A code names a session, and the Core will not go looking for which one, so
   * the session id has to travel with it. Either pass it as `sessionId`, or
   * pass a single `<sessionId>:<XXXX-XXXX>` string here and this reads both out
   * of it. Which of the two an operator is given is #280's to settle across
   * `actana pair new` (#283) and `actana core pair` (#285); both forms parse
   * here so that neither is a change to this module.
   */
  code: string;
  /** The pairing session the code belongs to, when `code` does not carry it. */
  sessionId?: string;
  /**
   * The CA fingerprint the operator read out, in any of the forms a human
   * copies it in: colon-separated or not, upper or lower case.
   *
   * **Absent is not "skip the check".** With no fingerprint this function
   * refuses with `fingerprint-unconfirmed` and reports the presented one in the
   * error, having sent no code — see {@link fetchCorePairingIdentity}.
   */
  expectedCaFingerprint?: string | null;
  /** What this machine calls itself, for the operator's `actana pair ls`. */
  label?: string;
  /** This machine's platform, e.g. `process.platform`. */
  platform?: string;
  /** Defaults to {@link DEFAULT_PAIRING_TIMEOUT_MS}, per connection. */
  timeoutMs?: number;
};

/**
 * Pair with a Core and return the credential it issued.
 *
 * The result is a {@link CoreRegistrationBlob} and nothing downstream can tell
 * it from a hand-carried one: `coreConnectionFromBlob` unpacks it,
 * `httpsBaseUrlFor` derives the HTTPS origin, the PEMs go into the mTLS
 * handshake and the bearer into the `auth` frame — exactly as they do today.
 * `clientKey` is the key generated on this machine a few lines above; it was
 * never sent, and the Core has never seen it.
 *
 * Throws {@link CorePairingError} for everything that is not a blob.
 */
export async function pairWithCore(opts: PairWithCoreOptions): Promise<CoreRegistrationBlob> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS;

  // Read the address and the ticket first. Both are failures a caller can fix
  // without a Core being involved, and neither is worth a dial to discover.
  const address = parseCoreAddress(opts.address);
  const ticket = parsePairingTicket(opts.code, opts.sessionId);
  const expected = opts.expectedCaFingerprint ? parseFingerprint(opts.expectedCaFingerprint) : null;

  const identity = await fetchCorePairingIdentity({ address: opts.address, timeoutMs });

  // ── The comparison, and everything that turns on it ──
  if (!expected) {
    throw new CorePairingError(
      "fingerprint-unconfirmed",
      `${identity.httpsOrigin} presents a certificate authority with fingerprint ${identity.fingerprint}; no expected fingerprint was given, so the pairing code was not sent`,
      { presentedFingerprint: identity.fingerprint, presentedCaCert: identity.caCert },
    );
  }
  if (expected !== identity.fingerprint) {
    throw new CorePairingError(
      "fingerprint-mismatch",
      `${identity.httpsOrigin} presented a certificate authority with fingerprint ${identity.fingerprint}, but ${expected} was expected — the pairing code was not sent`,
      {
        expectedFingerprint: expected,
        presentedFingerprint: identity.fingerprint,
        presentedCaCert: identity.caCert,
      },
    );
  }

  // Past the comparison, and only past it. The key pair is minted here rather
  // than above so that a mismatch costs a dial rather than a dial and an RSA
  // key generation — and so that nothing exists to be sent until the Core on
  // the other end is the one the operator described.
  const { csrPem, privateKeyPem } = await generateClientCsr(opts.label ?? "actana-client");

  const body: CorePairingRedeemRequest = {
    sessionId: ticket.sessionId,
    code: ticket.code,
    client: {
      ...(opts.label === undefined ? {} : { label: opts.label }),
      ...(opts.platform === undefined ? {} : { platform: opts.platform }),
    },
    csr: csrPem,
  };

  const answer = await postRedemption({
    host: address.host,
    port: address.port,
    origin: identity.httpsOrigin,
    caCert: identity.caCert,
    expectedFingerprint: expected,
    body: JSON.stringify(body),
    timeoutMs,
  });

  const issued = readRedeemResponse(answer, identity.httpsOrigin);

  // The CA in the response is the one every later dial pins, so it is held to
  // the same fingerprint the bootstrap dial was. A Core that presented one CA
  // in its handshake and handed back another would be asking this client to
  // trust something no human ever read out.
  const issuedFingerprint = fingerprintOf(pemToDer(issued.caCert));
  if (issuedFingerprint !== expected) {
    throw new CorePairingError(
      "fingerprint-mismatch",
      `${identity.httpsOrigin} answered with a certificate authority whose fingerprint is ${issuedFingerprint}, not the ${expected} it presented in the handshake`,
      { expectedFingerprint: expected, presentedFingerprint: issuedFingerprint },
    );
  }

  return {
    endpoint: issued.endpoint,
    ...(opts.label === undefined ? {} : { label: opts.label }),
    caCert: issued.caCert,
    clientCert: issued.clientCert,
    // The field that never crossed the wire, put back into the shape.
    clientKey: privateKeyPem,
    bearer: issued.bearer,
  };
}

// ─── The pieces ───

/** A pairing code, and the session it names. */
export type PairingTicket = { sessionId: string; code: string };

/**
 * Read a ticket out of what a human typed.
 *
 * The code is checked for *shape* — eight alphanumerics, hyphens and spaces
 * ignored — and not against the Core's alphabet. That is a deliberate stop:
 * the alphabet is an internal of `packages/shared` (which this package may not
 * import) and mirroring it here would be a copy free to drift, which ADR 0025
 * D3 is about. What the shape check buys is worth having on its own: a code
 * that could not be right whatever the alphabet is never spends one of the
 * five attempts the operator's session has.
 */
export function parsePairingTicket(input: string, sessionId?: string): PairingTicket {
  const trimmed = input.trim();
  const separator = trimmed.indexOf(":");
  const explicit = sessionId?.trim() ?? "";
  const carried = separator === -1 ? "" : trimmed.slice(0, separator).trim();
  // The prefix is stripped whenever there is one, whether or not a session id
  // was also passed: a caller that always forwards `--session` while letting an
  // operator paste whatever they were read out hands in both, and refusing that
  // would refuse the one shape this function exists to be tolerant of.
  const rawCode = separator === -1 ? trimmed : trimmed.slice(separator + 1);

  if (explicit !== "" && carried !== "" && explicit !== carried) {
    // Two session ids that disagree is not a shape to pick a winner from: one
    // of them is a mistake, and redeeming against the wrong session refuses in
    // a way that looks like a bad code.
    throw new CorePairingError(
      "bad-code",
      `the code names session "${carried}" and "${explicit}" was passed beside it — they must agree`,
    );
  }
  const session = explicit !== "" ? explicit : carried;
  if (session === "") {
    throw new CorePairingError(
      "bad-code",
      "a pairing code names a pairing session — pass the session id as `sessionId`, or a `<sessionId>:<XXXX-XXXX>` code",
    );
  }

  const stripped = rawCode.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(stripped)) {
    throw new CorePairingError(
      "bad-code",
      `a pairing code is eight characters, written XXXX-XXXX — "${rawCode.trim()}" is not`,
    );
  }
  return { sessionId: session, code: `${stripped.slice(0, 4)}-${stripped.slice(4)}` };
}

/** A Core's address, in the two forms this module needs it. */
type CoreAddress = { host: string; port: number; httpsOrigin: string };

/**
 * Read `host:port`, `https://host:port` or `wss://host:port`.
 *
 * `ws://` and `http://` are refused rather than upgraded: there is no
 * certificate on a plaintext dial, so there is no fingerprint to check, and
 * pairing over one would be the silent unverified exchange this module exists
 * to make impossible. A caller that meant the secure port should say so.
 */
export function parseCoreAddress(address: string): CoreAddress {
  const trimmed = address.trim();
  if (trimmed === "") throw new CorePairingError("bad-address", "a Core address is required");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CorePairingError("bad-address", `"${address}" is not a Core address — try host:port`);
  }
  if (url.protocol === "ws:" || url.protocol === "http:") {
    throw new CorePairingError(
      "bad-address",
      `pairing needs the Core's TLS port: "${address}" names a plaintext one, and there is no certificate on it to check the fingerprint against`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:") {
    throw new CorePairingError("bad-address", `"${address}" is not a Core address — try host:port`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "") throw new CorePairingError("bad-address", `"${address}" names no host`);
  const port = url.port === "" ? 443 : Number(url.port);
  return { host, port, httpsOrigin: `https://${url.host}` };
}

/**
 * A fingerprint as this module compares them: colon-separated uppercase hex,
 * which is the form `actana pair new` prints and a human copies.
 */
export function parseFingerprint(input: string): string {
  const hex = input.trim().replace(/^sha-?256[:=]/i, "").replace(/[\s:]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) {
    throw new CorePairingError(
      "bad-fingerprint",
      `"${input.trim()}" is not a SHA-256 fingerprint — expected 32 bytes of hex, as AA:BB:…`,
    );
  }
  return groupHex(hex);
}

/** SHA-256 over a certificate's DER, in the form {@link parseFingerprint} yields. */
export function fingerprintOf(der: Uint8Array): string {
  return groupHex(createHash("sha256").update(der).digest("hex").toUpperCase());
}

function groupHex(hex: string): string {
  return (hex.match(/../g) ?? []).join(":");
}

/**
 * The chain a Core presents, deepest certificate last.
 *
 * `rejectUnauthorized: false` is here and nowhere else in this file. It is what
 * "no trust anchor yet" means in code: the client has an address and a
 * fingerprint on a piece of paper, and the only way to compare the two is to
 * look at what the server presents. Nothing is sent on this socket, and it is
 * destroyed as soon as the chain has been copied out.
 */
function presentedChain(host: string, port: number, timeoutMs: number): Promise<DetailedPeerCertificate[]> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host,
      port,
      rejectUnauthorized: false,
      // An IP address is not a valid SNI server name (RFC 6066), and Node warns
      // about sending one. The certificate is identified by its fingerprint
      // here rather than by its name, so there is nothing to lose by omitting
      // it in that case.
      ...(isIP(host) === 0 ? { servername: host } : {}),
    });
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new CorePairingError("unreachable", `${host}:${port} did not answer within ${timeoutMs}ms`),
        ),
      );
    }, timeoutMs);
    socket.once("secureConnect", () => {
      const chain = chainOf(socket.getPeerCertificate(true));
      settle(() => resolve(chain));
    });
    socket.once("error", (err: Error) => {
      settle(() =>
        reject(
          new CorePairingError("unreachable", `${host}:${port} could not be reached: ${err.message}`, {}, { cause: err }),
        ),
      );
    });
  });
}

/**
 * Walk a peer certificate up to the root.
 *
 * Node hands back the chain as a linked list through `issuerCertificate`, and
 * terminates it by pointing the root at itself — so the loop stops on a
 * certificate it has already seen rather than on a null, which is the shape
 * that would spin forever.
 */
function chainOf(leaf: DetailedPeerCertificate): DetailedPeerCertificate[] {
  const chain: DetailedPeerCertificate[] = [];
  const seen = new Set<string>();
  let current: DetailedPeerCertificate | undefined = leaf;
  while (current && current.raw && !seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256);
    chain.push(current);
    current = current.issuerCertificate;
  }
  return chain;
}

/**
 * The certificate authority in a presented chain: the last one, when it is
 * self-issued.
 *
 * A Core presents its server certificate and the CA above it, and that CA — the
 * one `actana pair new` fingerprints from `PersistedMaterial.caCert` — is the
 * root of what it sends. If the chain ends somewhere else the Core has sent a
 * partial chain, and there is nothing here to compare: the alternative,
 * fingerprinting whatever is at the top, would compare the operator's CA
 * fingerprint against a leaf and fail with a mismatch that describes the wrong
 * problem.
 *
 * That makes "a Core presents a chain ending in its own root" a property of the
 * pairing flow rather than a detail of this file: a Core that later fronts an
 * intermediate, or serves a partial chain, breaks first contact for every
 * client. It belongs in #280 beside the rest of the flow's properties, and is
 * written here so the dependency is visible from the code that has it.
 */
function certificateAuthorityIn(chain: DetailedPeerCertificate[]): DetailedPeerCertificate | null {
  const top = chain.at(-1);
  if (!top) return null;
  return sameName(top.subject, top.issuer) ? top : null;
}

function sameName(a: PeerCertificate["subject"], b: PeerCertificate["issuer"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type RedemptionAnswer = { status: number; body: string; retryAfterSeconds?: number };

/**
 * Post the redemption on a connection pinned to the CA that just matched.
 *
 * Three things hold the code to that connection, and they are deliberately not
 * one thing: `ca` is the single certificate the bootstrap dial fingerprinted,
 * so no other authority can complete this handshake; `rejectUnauthorized` is
 * true, so the verification is enforced rather than reported; and
 * `checkServerIdentity` re-runs Node's own hostname check *and* the fingerprint
 * comparison, before the handshake completes and therefore before a byte of the
 * body is written. The last is redundant against the first two by construction
 * — which is the point of having it, since the first two are options on an
 * object and the day one of them is edited away the third still refuses.
 */
function postRedemption(opts: {
  host: string;
  port: number;
  origin: string;
  caCert: string;
  expectedFingerprint: string;
  body: string;
  timeoutMs: number;
}): Promise<RedemptionAnswer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: opts.host,
        port: opts.port,
        path: CORE_PAIRING_REDEEM_PATH,
        method: "POST",
        ca: opts.caCert,
        rejectUnauthorized: true,
        agent: false,
        ...(isIP(opts.host) === 0 ? { servername: opts.host } : {}),
        checkServerIdentity: (host: string, cert: PeerCertificate) => {
          const identity = checkTlsServerIdentity(host, cert);
          if (identity) return identity;
          const ca = certificateAuthorityIn(chainOf(cert as DetailedPeerCertificate));
          if (!ca) {
            return pinFailure(`${opts.origin} presented no certificate authority on the redemption dial`);
          }
          const presented = fingerprintOf(ca.raw);
          if (presented !== opts.expectedFingerprint) {
            return pinFailure(
              `${opts.origin} presented ${presented} on the redemption dial, not the ${opts.expectedFingerprint} it presented before`,
            );
          }
          return undefined;
        },
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(opts.body)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          const retryAfter = Number(res.headers["retry-after"]);
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: retryAfter } : {}),
          });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`no answer within ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    req.on("error", (err: Error) => {
      clearTimeout(timer);
      // Whatever this turns out to be, the body was never written: the failure
      // is the handshake's, and the code went nowhere. What is decided here is
      // only which of four things the operator is told — and one of them
      // accuses somebody, so see {@link classifyDialFailure}.
      const code = failureCode(err);
      const tls = code === undefined ? {} : { tlsCode: code };
      reject(dialFailure(classifyDialFailure(err), err, opts, tls));
    });
    req.end(opts.body);
  });
}

/** One sentence per {@link DialFailure}, and the failure that carries it. */
function dialFailure(
  kind: DialFailure,
  err: Error,
  opts: { origin: string; host: string; expectedFingerprint: string },
  tls: { tlsCode?: string },
): CorePairingError {
  const cause = { cause: err };
  if (kind === "pin") {
    return new CorePairingError(
      "fingerprint-mismatch",
      `${opts.origin} did not present the certificate authority whose fingerprint was confirmed — the pairing code was not sent (${err.message})`,
      { ...tls, expectedFingerprint: opts.expectedFingerprint },
      cause,
    );
  }
  if (kind === "hostname") {
    return new CorePairingError(
      "hostname-mismatch",
      `${opts.origin} presented the expected certificate authority, but its certificate does not cover ${opts.host} — dial the address this Core was set up for (${err.message})`,
      { ...tls, expectedFingerprint: opts.expectedFingerprint },
      cause,
    );
  }
  if (kind === "certificate") {
    return new CorePairingError(
      "certificate-invalid",
      `${opts.origin} presented the expected certificate authority, but its certificate could not be used: ${err.message}`,
      { ...tls, expectedFingerprint: opts.expectedFingerprint },
      cause,
    );
  }
  return new CorePairingError("unreachable", `${opts.origin} could not be reached: ${err.message}`, tls, cause);
}

/**
 * Turn an answer into a response or a {@link CorePairingError}.
 *
 * The mapping is the Core's status table read back: `403` is the one refusal
 * that covers four states, `429` carries a `retry-after` a caller can wait out,
 * `400` and its neighbours mean this client sent something wrong, and `404`
 * means the Core has no pairing endpoint at all — which is what an operator who
 * has not run `actana pair new` on a Core built before #282 will see.
 */
function readRedeemResponse(answer: RedemptionAnswer, origin: string): CorePairingRedeemResponse {
  if (answer.status !== 200) throw refusalFor(answer, origin);

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    throw new CorePairingError("malformed-response", `${origin} answered 200 with something that was not JSON`, {
      status: answer.status,
    });
  }
  // `JSON.parse("null")` succeeds, and an array parses too. Both would reach
  // the sweep below as something a field can be read off without complaint from
  // the compiler, and `null` would throw a raw `TypeError` out of a function
  // whose whole contract is that failures arrive as a `CorePairingError`.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CorePairingError("malformed-response", `${origin} answered 200 with something that was not an object`, {
      status: answer.status,
    });
  }
  const fields = parsed as Partial<Record<keyof CorePairingRedeemResponse, unknown>>;
  const missing = (["endpoint", "caCert", "clientCert", "bearer"] as const).filter(
    (field) => typeof fields[field] !== "string" || (fields[field] as string).length === 0,
  );
  if (missing.length > 0) {
    throw new CorePairingError(
      "malformed-response",
      `${origin} answered 200 without ${missing.join(", ")}`,
      { status: answer.status },
    );
  }
  // The endpoint decides whether anything later is protected at all.
  // `coreConnectionFromBlob` reads TLS off the scheme and nothing else: a
  // `ws://` endpoint yields `tls: null` **and still carries the bearer**, so a
  // Core that answered with one — misconfigured, or hostile — would hand back a
  // credential whose every later dial ships the bearer in cleartext with no
  // client certificate. That is the property this module spent a bootstrap
  // dial, a fingerprint comparison and a pinned second connection to establish,
  // undone by one field nobody looked at.
  const endpoint = (fields.endpoint as string).trim();
  if (!endpoint.startsWith("wss://")) {
    throw new CorePairingError(
      "malformed-response",
      `${origin} answered with the endpoint ${endpoint}, which is not a \`wss://\` core link — a paired credential is only a credential on one`,
      { status: answer.status },
    );
  }
  return {
    endpoint,
    caCert: fields.caCert as string,
    clientCert: fields.clientCert as string,
    bearer: fields.bearer as string,
  };
}

function refusalFor(answer: RedemptionAnswer, origin: string): CorePairingError {
  const body = safeRefusal(answer.body);
  const detail: CorePairingErrorDetail = {
    status: answer.status,
    ...(body.code === undefined ? {} : { coreCode: body.code }),
  };
  const said = body.error ?? `HTTP ${answer.status}`;

  if (answer.status === 429) {
    return new CorePairingError(
      "rate-limited",
      `${origin} is refusing pairing attempts for now: ${said}`,
      { ...detail, ...(answer.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: answer.retryAfterSeconds }) },
    );
  }
  if (answer.status === 403) {
    return new CorePairingError(
      "refused",
      `${origin} refused the pairing code: it is wrong, expired, already used, or the session is out of attempts`,
      detail,
    );
  }
  if (answer.status === 404) {
    return new CorePairingError("not-pairable", `${origin} has no pairing endpoint — ${said}`, detail);
  }
  if (answer.status >= 500) {
    return new CorePairingError("core-error", `${origin} failed to handle the redemption: ${said}`, detail);
  }
  return new CorePairingError("rejected", `${origin} would not accept the redemption: ${said}`, detail);
}

/**
 * The `code` this module's own `checkServerIdentity` refusals carry.
 *
 * Node reports a refusal from `checkServerIdentity` by destroying the socket
 * with the returned error, which arrives at the request as an ordinary
 * `error` event indistinguishable from a connection reset. Tagging it is what
 * lets {@link classifyDialFailure} tell "this is not the Core you confirmed"
 * from "nothing answered" — and from the two failures that are neither.
 */
const PIN_FAILURE_CODE = "ERR_ACTANA_PAIRING_PIN";

/** An error for `checkServerIdentity` to refuse a handshake with. */
function pinFailure(message: string): Error {
  return Object.assign(new Error(message), { code: PIN_FAILURE_CODE });
}

/**
 * Was this failure about the certificate at all?
 *
 * OpenSSL's verdicts reach Node as `code` — `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
 * `CERT_HAS_EXPIRED` and the rest of a list too long and too version-dependent
 * to enumerate — beside the `ERR_TLS_*` family Node raises itself. Matched by
 * prefix, deliberately: a verification failure this predicate did not recognise
 * would be reported as `unreachable`, which sends an operator looking at their
 * network for a problem that is in their certificates.
 *
 * It answers only that question. Which certificate failure it was — the pin,
 * the hostname, or an unusable certificate — is {@link classifyDialFailure}'s,
 * and that one is enumerated rather than guessed.
 */
function certificateFailure(code: string): boolean {
  return (
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.includes("CERT") ||
    code.startsWith("UNABLE_TO_") ||
    code.startsWith("DEPTH_ZERO_") ||
    code.startsWith("SELF_SIGNED_")
  );
}

/**
 * OpenSSL verdicts that mean **this chain does not lead to the pinned CA**.
 *
 * Every one of them is a statement about who signed what: no issuer, an issuer
 * that is not the one supplied, a signature that does not check out, a chain
 * that ends in a self-signed certificate that is not the pinned root. On a dial
 * whose `ca` is the single certificate the operator's fingerprint matched,
 * that is the pin refusing — the same event `checkServerIdentity` reports when
 * it gets far enough to run.
 *
 * Enumerated rather than prefix-matched, because this is the set that decides
 * whether a person is told they are being attacked.
 */
const CHAIN_FAILURE_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "INVALID_CA",
]);

/** Node's own verdict when a certificate does not cover the address dialled. */
const HOSTNAME_FAILURE_CODE = "ERR_TLS_CERT_ALTNAME_INVALID";

/** What a failed redemption dial was actually about. */
type DialFailure =
  /** The peer is not the Core whose CA fingerprint was confirmed. */
  | "pin"
  /** The right CA, on an address its certificate does not cover. */
  | "hostname"
  /** The right CA, and a certificate that is expired or otherwise unusable. */
  | "certificate"
  /** Nothing about certificates: refused, reset, timed out. */
  | "transport";

/**
 * Classify a failure on the pinned dial.
 *
 * The distinction this draws is the module's most consequential sentence, and
 * it used to be drawn wrong: any code containing `CERT` was reported as a
 * fingerprint mismatch, so `ERR_TLS_CERT_ALTNAME_INVALID` — a Core set up for
 * one address and reached at another, which `core-cert-material.ts` makes an
 * ordinary configuration rather than an exotic one — told the operator they
 * were being intercepted. So did an expired server certificate. **A
 * misconfigured Core must not be reported as an attack**: the person who reads
 * that goes looking for an attacker instead of for their own SAN list.
 *
 * So the width and the accusation are now two separate decisions.
 * {@link certificateFailure} still decides broadly whether the failure was
 * about the certificate at all — being wrong there only costs the wrong noun.
 * Whether it was the *pin* is decided by an enumerated set plus the tagged
 * refusal, and anything certificate-shaped that is in neither is reported as an
 * invalid certificate. Nothing is lost by that default: the exchange is refused
 * either way and the code was never written to the socket — the only thing that
 * changes is which sentence a person is shown.
 */
function classifyDialFailure(err: unknown): DialFailure {
  const code = String((err as { code?: unknown } | null)?.code ?? "");
  if (code === PIN_FAILURE_CODE) return "pin";
  if (CHAIN_FAILURE_CODES.has(code)) return "pin";
  if (code === HOSTNAME_FAILURE_CODE) return "hostname";
  return certificateFailure(code) ? "certificate" : "transport";
}

/** The `code` a dial failure carried, for {@link CorePairingErrorDetail.tlsCode}. */
function failureCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function safeRefusal(body: string): CorePairingRefusalBody {
  try {
    const parsed = JSON.parse(body) as CorePairingRefusalBody;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** DER to a PEM `CERTIFICATE`, in the 64-column form every PEM reader expects. */
function derToCertificatePem(der: Uint8Array): string {
  const body = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/** The first certificate in a PEM, as DER. Throws nothing: an empty PEM yields no bytes. */
function pemToDer(pem: string): Uint8Array {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  return new Uint8Array(Buffer.from((match?.[1] ?? "").replace(/\s+/g, ""), "base64"));
}
