// The Core's pairing store: the SDK's JSON-file store, with one method made
// stricter.
//
// `jsonFileStore` from `@actana/sdk/pairing/stores/json-file` is the file
// `actana pair new` writes and the redeem route reads. Its `revokedSerials()`
// reads the file *leniently*, the way it reads it for everything else: a
// missing, truncated or hand-mangled `pairing.json` is "no rows", and no rows
// means no revocations.
//
// That is the wrong answer for the one method the revocation set is built from.
// A revocation list that cannot be read has not been checked, and a Core that
// serves every client whose revocation it failed to read is a Core that
// un-revokes them all the moment the file is damaged. Control 0.4.x failed
// closed here — an unreadable store made `PairingRevocations` treat every
// pairing as revoked until the file was readable again — and the SDK ships the
// reader that makes that possible (`readPairingRecordsStrict`, which throws on
// anything but a file that is absent or well-formed) without wiring it into
// `revokedSerials`. This wrapper does the wiring, so a Core on the shared
// SDK keeps the property.
import { jsonFileStore, readPairingRecordsStrict } from "@actana/sdk/pairing/stores/json-file";

export type CorePairingStore = ReturnType<typeof jsonFileStore>;

/** The pairing store for the file at `filePath`, failing closed on revocations. */
export function corePairingStore(filePath: string): CorePairingStore {
  const store = jsonFileStore(filePath);
  return {
    createSession: (session) => store.createSession(session),
    claimAttempt: (sessionId, now) => store.claimAttempt(sessionId, now),
    consume: (sessionId, now) => store.consume(sessionId, now),
    releaseAttempt: (sessionId) => store.releaseAttempt(sessionId),
    recordClient: (client) => store.recordClient(client),
    revoke: (target) => store.revoke(target),
    listSessions: () => store.listSessions(),
    listClients: () => store.listClients(),
    revokedSerials: async () => {
      // Throws when the file is unreadable, which is the signal. A file that
      // does not exist yet is a Core that has paired nothing, and reads as empty.
      const records = readPairingRecordsStrict(filePath);
      return new Set(records.clients.filter((row) => row.revokedAt !== null).map((row) => row.certSerial));
    },
  };
}
