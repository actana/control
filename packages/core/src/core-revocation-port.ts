// What the core-link server needs to know about revocation, and nothing more.
//
// The set itself — read from the pairing store, failing closed when the store
// cannot be read, swept every second — lives in `@actana/sdk/pairing/server`
// and is reached through `createPairing(...).gate.revocations`. The server asks
// it two questions, so it is typed by those two rather than by the SDK's class:
// the class is not part of the SDK's public surface, and a test can hand the
// server a two-method object.

/** The two questions the core-link server puts to the revocation set. */
export type CoreRevocations = {
  /** Is the certificate with this serial revoked? Unreadable store: yes, for every serial. */
  isRevoked(certSerial: string | null | undefined): boolean;
  /** Does this bearer subject (`pair:<serial>`) name a revoked pairing? */
  isBearerSubjectRevoked(sub: string | undefined): boolean;
};

const BEARER_SUBJECT_PREFIX = "pair:";

/**
 * The serial inside a `pair:<serial>` bearer subject, or `null` for any other
 * subject. For the log line that names a refused bearer — the decision itself
 * is {@link CoreRevocations.isBearerSubjectRevoked}.
 */
export function certSerialFromBearerSubject(sub: string | undefined): string | null {
  if (!sub || !sub.startsWith(BEARER_SUBJECT_PREFIX)) return null;
  const serial = sub.slice(BEARER_SUBJECT_PREFIX.length);
  return serial.length > 0 ? serial : null;
}
