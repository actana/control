// Pairing, as the browser half of the Panel sees it (#280, #286).
//
// The pairing call itself is Node-side work — a key pair is born, a TLS chain
// is read, a code is spent — so it runs on the Panel server beside the other
// Core-side services and never in a tab (CONTEXT.md "Dumb pipe", ADR 0030).
// What crosses to the renderer is exactly what this module declares: an
// address to dial, a fingerprint to look at, a failure to explain. No key, no
// certificate, no code.
//
// Two things here look like copies of `@actana/sdk/core-pairing` and are
// deliberately not:
//
//   • {@link CorePairingFailureCode} restates the SDK's failure union so that a
//     browser bundle never reaches into a module that opens `node:tls`. The
//     server asserts the two are the same union at compile time
//     (`server/services/core-pairing.ts`), so a member added to the SDK fails
//     the typecheck here rather than silently rendering as "unknown".
//   • {@link normalizeFingerprint} and {@link normalizePairingCode} are *input
//     tidying*, not enforcement. The comparison that decides whether a code is
//     sent is the SDK's, re-run on the server against the certificate the Core
//     presented — a browser that skipped everything below still cannot get a
//     code past a fingerprint that does not match.

/**
 * Why a pairing attempt did not produce a Core.
 *
 * Structurally the SDK's `CorePairingFailure`. Switch on it to write a
 * sentence; the message that comes with it is already written for the
 * operator, and neither ever carries the code or the key.
 */
export type CorePairingFailureCode =
  | "bad-address"
  | "bad-code"
  | "bad-fingerprint"
  | "unreachable"
  | "no-ca-presented"
  | "fingerprint-unconfirmed"
  | "fingerprint-mismatch"
  | "hostname-mismatch"
  | "certificate-invalid"
  | "refused"
  | "rate-limited"
  | "rejected"
  | "not-pairable"
  | "core-error"
  | "malformed-response";

/**
 * What a refused pairing tells the browser.
 *
 * Fingerprints are in here because a mismatch has to *show* both halves to be
 * a refusal an operator can act on rather than a shrug (#286). Everything a
 * refusal could have carried and does not — the code, the CSR, the issued
 * certificate, the key — is absent by construction: the server builds this
 * shape field by field rather than serialising an error it caught.
 */
export type CorePairingRefusalDetail = {
  /** On a mismatch: the fingerprint the operator said to expect. */
  expectedFingerprint?: string;
  /** On a mismatch: the fingerprint the Core actually presented. */
  presentedFingerprint?: string;
  /** On `rate-limited`: how long the Core asked us to wait. */
  retryAfterSeconds?: number;
};

export type CorePairingRefusal = CorePairingRefusalDetail & {
  failure: CorePairingFailureCode;
  /**
   * Operator-facing, and the same string {@link pairingFailureMessage} would
   * write: the server fills it in so that a caller reading only `error` — the
   * generic API client, a log of a failed request — still gets the sentence
   * rather than a bare code.
   */
  error: string;
};

/** What a bootstrap dial learned about a Core, as the browser is told it. */
export type CorePairingIdentity = {
  /** SHA-256 over the CA's DER, colon-separated uppercase hex. */
  fingerprint: string;
  /** `https://host:port` — the surface that was dialled. */
  httpsOrigin: string;
};

export type CorePairingIdentityResponse = { identity: CorePairingIdentity };

/** Where the operator stands against the fingerprint they were read out. */
export type FingerprintCheck = "unchecked" | "verified" | "mismatch";

/**
 * Compare what the operator typed with what the Core presented.
 *
 * `unchecked` is the answer for an empty box *and* for a half-typed one: a
 * fingerprint is 32 bytes or it is nothing, and calling a prefix "mismatched"
 * would paint the box red for every operator on their way to typing it.
 */
export function fingerprintCheck(expected: string, presented: string | null): FingerprintCheck {
  if (presented === null) return "unchecked";
  const normalized = normalizeFingerprint(expected);
  if (normalized === null) return "unchecked";
  return normalized === normalizeFingerprint(presented) ? "verified" : "mismatch";
}

/**
 * A SHA-256 fingerprint in the one form this Panel compares them in:
 * colon-separated uppercase hex, which is what `actana pair new` prints.
 *
 * Null for anything that is not 32 bytes of hex. Whitespace, colons, case and
 * a leading `sha256:` are all things a human copying off a terminal brings
 * along, and none of them is a mismatch.
 */
export function normalizeFingerprint(input: string): string | null {
  const hex = input.trim().replace(/^sha-?256[:=]/i, "").replace(/[\s:]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return (hex.match(/../g) ?? []).join(":");
}

/**
 * A pairing code as `actana pair new` printed it — `XXXX-XXXX`, uppercase.
 *
 * Null when what was typed could not be a code whatever the Core's alphabet
 * is. Hyphens, spaces and case are the operator's to get wrong: eight
 * characters is the only thing asserted here, and the Core is the only thing
 * that knows whether they are the right eight.
 */
export function normalizePairingCode(input: string): string | null {
  const stripped = input.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(stripped)) return null;
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
}

/**
 * What to tell the operator, and what to do about it.
 *
 * Every arm names the next action, because a pairing failure is always
 * somebody's move: mint a new code on the Core, fix the address, wait, or stop
 * and find out why a machine is presenting a certificate authority nobody read
 * out. The Core answers a wrong, expired, spent and exhausted code with one
 * indistinguishable refusal on purpose (#282), so `refused` names all four and
 * points at the Core's audit log rather than guessing between them.
 */
export function pairingFailureMessage(
  failure: CorePairingFailureCode,
  detail: CorePairingRefusalDetail = {},
): string {
  switch (failure) {
    case "bad-address":
      return "That is not a Core address. Use the machine's host and TLS port, as host:port — pairing needs the TLS port, not a plaintext one.";
    case "bad-code":
      return "That is not a pairing code. `actana pair new` prints eight characters as XXXX-XXXX, and the session id on the line below it.";
    case "bad-fingerprint":
      return "That is not a SHA-256 fingerprint. Copy the whole `CA fingerprint` line from `actana pair new`.";
    case "unreachable":
      return "Nothing answered at that address. Check the Core is running and that this Panel can reach its TLS port, then try again.";
    case "no-ca-presented":
      return "That machine presented no certificate authority, so there is nothing to compare the fingerprint against. It is not a Core, or not the one you meant.";
    case "fingerprint-unconfirmed":
      return "The fingerprint was not confirmed, so the pairing code was not sent. Compare the Core's fingerprint with the one `actana pair new` printed.";
    case "fingerprint-mismatch":
      return "That machine is not the Core you were given a fingerprint for. The pairing code was NOT sent. Do not retry until you know why they differ.";
    case "hostname-mismatch":
      return "The right Core, on an address its certificate does not cover. Reach it on the host it was set up for, or reissue its certificate for this one.";
    case "certificate-invalid":
      return "The Core's certificate is expired or otherwise unusable, so the pairing dial could not be pinned to it. Fix the certificate on the machine first.";
    case "refused":
      return "The Core refused this code: wrong, expired, already used, or out of attempts. Run `actana pair new` on the machine and pair again with the fresh code.";
    case "rate-limited":
      return detail.retryAfterSeconds === undefined
        ? "The Core is rate-limiting pairing attempts. Wait a moment and try again."
        : `The Core is rate-limiting pairing attempts. Wait ${detail.retryAfterSeconds}s and try again.`;
    case "rejected":
      return "The Core would not accept the pairing request. Check the Panel and the Core are on the same release, and report it if they are.";
    case "not-pairable":
      return "That Core has no pairing endpoint. Update the Core on that machine, then run `actana pair new` there.";
    case "core-error":
      return "The Core failed while redeeming the code. Nothing was paired — check the Core's logs, then run `actana pair new` and try again.";
    case "malformed-response":
      return "That address answered, but not like a Core. Check the address, and that nothing is proxying the Core's TLS port.";
  }
}
