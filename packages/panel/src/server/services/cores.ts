import { randomBytes } from "node:crypto";
import { decodeRegistrationBlob } from "@actana/shared/registration-blob";
import { getPanelDb } from "../panel-db";
import { OPERATOR_ID } from "./operator";
import { openSecret, sealSecret } from "./secrets-at-rest";
import type { Core } from "~/shared/cores";

/**
 * The Core registry — the Panel's list of Harnesses it can talk to, plus the
 * sealed credentials it dials them with.
 *
 * Registration is one paste: the operator hands over the registration blob
 * that `harness install` printed ("pairing token" in what the UI says), the
 * endpoint and label land in `cores`, and the secret half is sealed into
 * `core_secrets`. There is no other way in; the Panel does not accept a
 * hand-typed endpoint, because a Core without pinned mTLS material is a Core
 * it cannot safely dial.
 */

/** The secret half of a registration. Never leaves the service. */
export type CoreSecrets = {
  /** PEM CA that signed the Harness server cert — pinned by the dialer. */
  caCert: string;
  /** PEM client cert presented in the mTLS handshake. */
  clientCert: string;
  /** PEM private key for {@link CoreSecrets.clientCert}. */
  clientKey: string;
  /** Signed bearer presented in the core-link `auth` frame. */
  bearer: string;
};

/**
 * A registration blob the Panel won't accept. `expose` marks it caller-facing
 * so the API router returns the message rather than swallowing it into a 500 —
 * the operator needs to know *that* the paste was bad, and the messages here
 * deliberately say nothing about the blob's contents.
 */
export class RegistrationBlobError extends Error {
  readonly expose = true;
  constructor(message: string) {
    super(message);
    this.name = "RegistrationBlobError";
  }
}

type CoreRow = {
  id: string;
  endpoint: string;
  label: string;
  last_event_id: number;
  created_at: number;
  updated_at: number;
};

function rowToCore(row: CoreRow): Core {
  return {
    id: row.id,
    endpoint: row.endpoint,
    label: row.label,
    lastEventId: row.last_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `core_` + 64 bits. Not a secret — a collision-resistant handle. */
function newCoreId(): string {
  return `core_${randomBytes(8).toString("hex")}`;
}

/**
 * A Core with no alias in its blob still needs something to be called in the
 * UI. The host is what the operator recognizes; they can't rename yet, so
 * getting this wrong means an unidentifiable row.
 */
function labelFor(rawLabel: string, endpoint: string): string {
  const trimmed = rawLabel.trim();
  if (trimmed) return trimmed.slice(0, 120);
  try {
    return new URL(endpoint).hostname || endpoint;
  } catch {
    return endpoint;
  }
}

export function listCores(): Core[] {
  const rows = getPanelDb()
    .prepare("SELECT * FROM cores ORDER BY created_at ASC")
    .all() as CoreRow[];
  return rows.map(rowToCore);
}

export function getCore(id: string): Core | null {
  const row = getPanelDb().prepare("SELECT * FROM cores WHERE id = ?").get(id) as
    | CoreRow
    | undefined;
  return row ? rowToCore(row) : null;
}

/**
 * Register a Core from a pasted registration blob.
 *
 * Both rows go in under one transaction: a Core in the registry that the
 * dialer has no credentials for would sit in the fleet showing "unreachable"
 * forever with no way to fix it but a manual delete. Either the Core is
 * registered and dialable, or nothing happened.
 */
export function registerCoreFromRegistrationBlob(raw: unknown): Core {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new RegistrationBlobError("Paste the pairing token from `harness install`.");
  }
  const blob = decodeRegistrationBlob(raw);
  // The codec only type-checks its fields, so a blob with an empty cert or
  // bearer decodes cleanly. Registering one would produce a Core that can
  // never connect and can't be re-paired (its endpoint is taken) — reject it
  // here, where the operator still has the paste in front of them.
  if (!blob || !blob.caCert.trim() || !blob.clientCert.trim() || !blob.clientKey.trim() || !blob.bearer.trim()) {
    throw new RegistrationBlobError(
      "That isn't a valid pairing token. Copy the whole line `harness install` printed and paste it again.",
    );
  }

  const endpoint = blob.endpoint.trim();
  const id = newCoreId();
  const now = Date.now();
  const secrets: CoreSecrets = {
    caCert: blob.caCert,
    clientCert: blob.clientCert,
    clientKey: blob.clientKey,
    bearer: blob.bearer,
  };
  // Sealed before the transaction opens: a misconfigured AC_SECRETS_KEY should
  // fail the registration outright, not leave a half-written one to roll back.
  const sealed = sealSecret(JSON.stringify(secrets));

  const db = getPanelDb();
  const insert = db.transaction(() => {
    if (db.prepare("SELECT id FROM cores WHERE endpoint = ?").get(endpoint)) {
      throw new RegistrationBlobError(`A Core at ${endpoint} is already registered.`);
    }
    db.prepare(
      `INSERT INTO cores (id, operator_id, endpoint, label, last_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, OPERATOR_ID, endpoint, labelFor(blob.label ?? "", endpoint), now, now);
    db.prepare("INSERT INTO core_secrets (core_id, sealed, updated_at) VALUES (?, ?, ?)").run(
      id,
      sealed,
      now,
    );
  });
  insert();

  const core = getCore(id);
  if (!core) throw new Error("failed to read back the registered Core");
  return core;
}

/**
 * Unseal a Core's credentials for the dialer. Null when the Core is unknown,
 * or when the sealed blob can't be opened — a data directory restored without
 * its key file, say. The dialer surfaces that as a link that can't be made
 * rather than dialing with nothing.
 */
export function getCoreSecrets(id: string): CoreSecrets | null {
  const row = getPanelDb().prepare("SELECT sealed FROM core_secrets WHERE core_id = ?").get(id) as
    | { sealed: Uint8Array }
    | undefined;
  if (!row) return null;
  const json = openSecret(Buffer.from(row.sealed));
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as CoreSecrets;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Move the Panel-owned replay cursor forward. Forward only: a reconnect can
 * arrive with a stale number (a client that missed a batch, a racing writer),
 * and rewinding would make the Harness replay a stretch the Panel already
 * processed.
 */
export function advanceCoreCursor(id: string, lastEventId: number): void {
  if (!Number.isInteger(lastEventId) || lastEventId < 0) return;
  getPanelDb()
    .prepare(
      `UPDATE cores SET last_event_id = ?, updated_at = ?
       WHERE id = ? AND last_event_id < ?`,
    )
    .run(lastEventId, Date.now(), id, lastEventId);
}

export function getCoreCursor(id: string): number {
  return getCore(id)?.lastEventId ?? 0;
}

/**
 * Forget a Core: registry row, sealed secrets, and cursor all go. Returns
 * false for an unknown id. Harness-side state is untouched — removing a Core
 * is the Panel forgetting a machine, not the machine forgetting its work.
 */
export function removeCore(id: string): boolean {
  const db = getPanelDb();
  const remove = db.transaction(() => {
    // Explicit rather than leaning on the cascade: `foreign_keys` is a
    // per-connection pragma, and losing a row of sealed credentials to a
    // pragma default is not a failure mode worth having.
    db.prepare("DELETE FROM core_secrets WHERE core_id = ?").run(id);
    return db.prepare("DELETE FROM cores WHERE id = ?").run(id).changes > 0;
  });
  return remove();
}
