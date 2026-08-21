import { randomBytes } from "node:crypto";
import { getPanelDb } from "../panel-db";
import { OPERATOR_ID } from "./operator";
import { openSecret, sealSecret } from "./secrets-at-rest";
import type { Core } from "~/shared/cores";

/**
 * The Core registry — the Panel's list of Cores it can talk to, plus the
 * sealed credentials it dials them with.
 *
 * A registration is one credential: an endpoint, the mTLS material and the
 * bearer. The endpoint and label land in `cores` and the secret half is sealed
 * into `core_secrets`. The Panel does not accept a hand-typed endpoint,
 * because a Core without pinned mTLS material is a Core it cannot safely dial.
 *
 * **One door leads here: {@link registerCoreFromCredential}.** A short pairing
 * code is redeemed against the Core by `services/core-pairing.ts` (#286), which
 * hands back a credential whose private key never crossed the wire, and that
 * credential is registered. There is no second way in — the pasted registration
 * blob `actana setup` used to print was the other door and #287 removed it,
 * outright and with no compatibility shim (#280). A registration path nobody
 * exercises is a second way to become a Core client with its own security
 * properties, which is the thing that removal exists to prevent.
 */

/** The secret half of a registration. Never leaves the service. */
export type CoreSecrets = {
  /** PEM CA that signed the Core server cert — pinned by the dialer. */
  caCert: string;
  /** PEM client cert presented in the mTLS handshake. */
  clientCert: string;
  /** PEM private key for {@link CoreSecrets.clientCert}. */
  clientKey: string;
  /** Signed bearer presented in the core-link `auth` frame. */
  bearer: string;
};

/**
 * A credential the registry itself won't take — an endpoint already spoken
 * for, or material with a field missing. `expose` marks it caller-facing so the
 * API router returns the message rather than swallowing it into a 500, and it
 * is worded without reference to how the credential arrived: pairing is the one
 * door today, and a message naming it would have to be rewritten by whatever
 * opens the next one.
 */
export class CoreRegistryError extends Error {
  readonly expose = true;
  constructor(message: string) {
    super(message);
    this.name = "CoreRegistryError";
  }
}

/**
 * What a registration is made of.
 *
 * Structurally `CoreRegistrationBlob` from `@actana/sdk` — declared here rather
 * than imported so the registry depends on the *shape* of a credential and not
 * on any one producer of it. A **Registration blob** is still exactly this: the
 * credential a paired client holds. What #287 removed is the base64 artifact a
 * human used to carry, not the thing it carried.
 */
export type CoreCredential = {
  /** `wss://host:port` — the core-link endpoint the dialer will use. */
  endpoint: string;
  /** The name the credential carried, if any. Overridden by an explicit one. */
  label?: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  bearer: string;
};

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
 * Normalize an alias for the registry: trimmed, capped at 120 characters, and
 * falling back to the endpoint's host when what's left is empty.
 *
 * Both ways in go through here — the label a pairing produced, and whatever
 * the operator types into a rename — so neither can leave a row with
 * nothing to identify it by. The host is the fallback because it is what the
 * operator recognizes about a machine they haven't named themselves.
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

/**
 * Is a Core already registered at this endpoint?
 *
 * The same question {@link registerCoreFromCredential} asks inside its
 * transaction, exposed so a caller holding something expensive and perishable
 * can ask it *first*. Pairing does (#286): discovering the collision after the
 * redemption costs the operator their one-time code and leaves the Core holding
 * a signed certificate for a client this Panel never stored.
 *
 * An answer here is advice, not a decision — the endpoint a Core reports is its
 * own, and need not be the address it was reached on. The check inside the
 * transaction stays the authority.
 */
export function coreRegisteredAt(endpoint: string): boolean {
  return (
    getPanelDb().prepare("SELECT id FROM cores WHERE endpoint = ?").get(endpoint.trim()) !==
    undefined
  );
}

export function getCore(id: string): Core | null {
  const row = getPanelDb().prepare("SELECT * FROM cores WHERE id = ?").get(id) as
    | CoreRow
    | undefined;
  return row ? rowToCore(row) : null;
}

/**
 * Register a Core from the credential a pairing produced.
 *
 * Both rows go in under one transaction: a Core in the registry that the
 * dialer has no credentials for would sit in the fleet showing "unreachable"
 * forever with no way to fix it but a manual delete. Either the Core is
 * registered and dialable, or nothing happened.
 *
 * `label` is the Panel's alias for the *machine* and is passed explicitly by a
 * caller that has one — pairing does, because the label it sent the Core names
 * this Panel rather than the machine, and letting that come back round as the
 * alias would fill the fleet list with the Panel's own name.
 */
export function registerCoreFromCredential(
  credential: CoreCredential,
  opts: { label?: string } = {},
): Core {
  if (
    !credential.caCert.trim() ||
    !credential.clientCert.trim() ||
    !credential.clientKey.trim() ||
    !credential.bearer.trim()
  ) {
    throw new CoreRegistryError("That credential is missing material the Panel needs to dial the Core.");
  }

  const endpoint = credential.endpoint.trim();
  if (!endpoint) throw new CoreRegistryError("That credential names no Core endpoint.");

  const id = newCoreId();
  const now = Date.now();
  const secrets: CoreSecrets = {
    caCert: credential.caCert,
    clientCert: credential.clientCert,
    clientKey: credential.clientKey,
    bearer: credential.bearer,
  };
  // Sealed before the transaction opens: a misconfigured AC_SECRETS_KEY should
  // fail the registration outright, not leave a half-written one to roll back.
  const sealed = sealSecret(JSON.stringify(secrets));

  const db = getPanelDb();
  const insert = db.transaction(() => {
    if (db.prepare("SELECT id FROM cores WHERE endpoint = ?").get(endpoint)) {
      throw new CoreRegistryError(`A Core at ${endpoint} is already registered.`);
    }
    db.prepare(
      `INSERT INTO cores (id, operator_id, endpoint, label, last_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, OPERATOR_ID, endpoint, labelFor(opts.label ?? credential.label ?? "", endpoint), now, now);
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
 * Rename a Core. Returns the updated row, or null for an unknown id.
 *
 * The alias is Panel-local presentation, not a Core fact (CONTEXT.md, "Core
 * alias"): nothing is sent to the machine and no core-link frame carries it,
 * so another Panel registered against the same Core keeps its own name for it.
 * That is the point of the field, not drift.
 *
 * The label goes through {@link labelFor}, the same normalization registration
 * uses — so an operator who clears the box gets the endpoint host back rather
 * than a blank row, and the caller is handed what was actually stored.
 */
export function renameCore(id: string, label: string): Core | null {
  const existing = getCore(id);
  if (!existing) return null;
  getPanelDb()
    .prepare("UPDATE cores SET label = ?, updated_at = ? WHERE id = ?")
    .run(labelFor(label, existing.endpoint), Date.now(), id);
  return getCore(id);
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
 * and rewinding would make the Core replay a stretch the Panel already
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
 * false for an unknown id. Core-side state is untouched — removing a Core
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
