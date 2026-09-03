import { readJson, writeJson } from "./local-storage-json";

/**
 * Persisted identity for the Panel's user terminals (issue 394).
 *
 * The row behind a user terminal lives in `home_terminals` whatever scope it
 * was opened in (issue 266), so the row alone cannot say *which* shell it is:
 * the project it was opened on, the Core its PTY runs on, the kind of shell the
 * pane must spawn and the cwd it opens at were all in-memory only. A reload
 * therefore lost the pane from its project, and Home — the one scope that did
 * reload its rows — re-spawned them as plain home shells: a different shell
 * kind, in a different place, from the one the operator opened.
 *
 * This module is the missing half: a small localStorage map, terminal id →
 * identity, written when a terminal is opened and dropped when it is killed.
 * What it cannot answer it refuses to guess — a row with no identity is not
 * restored at all, so a reload shows that terminal gone on purpose rather than
 * spawning a different one somewhere else.
 */

/** localStorage key for the identity map. */
export const IDENTITY_STORAGE_KEY = "mc.userTerminalIdentity";

/**
 * Which shell a terminal is, i.e. which spawn the pane must make. One value per
 * branch in `UserTerminalPane`'s spawn, so restoring a terminal cannot land it
 * on a different one:
 * - `vm-shell` — a VM Shell Session (issue 06): a login shell on the Core's own
 *   machine, spawned with `shellSession: true` and no cwd;
 * - `home`     — a shell at the Core's home dir, spawned with the `home` flag;
 * - `project`  — a shell at a project path, spawned with that cwd.
 */
export type UserTerminalKind = "vm-shell" | "home" | "project";

const KINDS: readonly UserTerminalKind[] = ["vm-shell", "home", "project"];

export type UserTerminalIdentity = {
  /** Terminal-store bucket this shell belongs to (`<projectId>:main`, or home). */
  scopeKey: string;
  /** The Core the shell runs on; null when it was opened without one in scope. */
  coreId: string | null;
  kind: UserTerminalKind;
  /** The cwd the shell opens at. Empty for kinds the Core resolves itself. */
  cwd: string;
};

export type UserTerminalIdentityMap = Record<string, UserTerminalIdentity>;

function isIdentity(value: unknown): value is UserTerminalIdentity {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.scopeKey === "string" &&
    record.scopeKey.length > 0 &&
    (record.coreId === null || typeof record.coreId === "string") &&
    KINDS.includes(record.kind as UserTerminalKind) &&
    typeof record.cwd === "string"
  );
}

/**
 * Keep only well-formed entries. A half-written or hand-edited bucket must not
 * be able to restore a terminal as something it never was — an entry that does
 * not parse is treated exactly like a missing one.
 */
export function parseIdentityMap(raw: unknown): UserTerminalIdentityMap {
  if (!raw || typeof raw !== "object") return {};
  const out: UserTerminalIdentityMap = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isIdentity(value)) out[id] = value;
  }
  return out;
}

export function readIdentityMap(): UserTerminalIdentityMap {
  return parseIdentityMap(readJson<unknown>(IDENTITY_STORAGE_KEY, {}));
}

export function writeIdentityMap(map: UserTerminalIdentityMap): void {
  writeJson(IDENTITY_STORAGE_KEY, map);
}

/** Drop entries for terminal ids that are gone (killed, or absent server-side). */
export function forgetIdentities(
  map: UserTerminalIdentityMap,
  ids: Iterable<string>,
): UserTerminalIdentityMap {
  let next: UserTerminalIdentityMap | null = null;
  for (const id of ids) {
    if (!(id in map)) continue;
    next ??= { ...map };
    delete next[id];
  }
  return next ?? map;
}

/**
 * Drop entries whose terminal no longer exists, so the bucket cannot grow forever.
 *
 * `liveIds` is a snapshot from a list call, and a terminal can be opened while
 * that call is in flight: its identity is written, its row exists, and neither
 * is in the snapshot. Pruning on the snapshot alone would delete that identity
 * and strand its row — unrestorable on the next load and never cleaned up
 * either, since restore only knows rows it can identify. So a candidate set is
 * required: only ids that were already known when the request was issued may be
 * pruned, which is exactly the set the answer is evidence about.
 */
export function pruneIdentities(
  map: UserTerminalIdentityMap,
  liveIds: ReadonlySet<string>,
  candidateIds: ReadonlySet<string>,
): UserTerminalIdentityMap {
  const stale = Object.keys(map).filter((id) => candidateIds.has(id) && !liveIds.has(id));
  return forgetIdentities(map, stale);
}

/**
 * Persist this tab's change as a change, not as a whole-bucket overwrite.
 *
 * The map is shared by every tab on this Panel, and each one holds a snapshot
 * taken when it mounted. Writing that snapshot back would delete identities
 * another tab wrote in the meantime — and an identity is not a preference: lose
 * it and its terminal can never be restored again, and its row is never cleaned
 * up. So the stored map is re-read at write time and only this tab's own delta
 * is applied: entries it added or changed are written, and entries it removed —
 * and only those — are removed.
 */
export function commitIdentityChange(
  before: UserTerminalIdentityMap,
  after: UserTerminalIdentityMap,
): UserTerminalIdentityMap {
  const merged: UserTerminalIdentityMap = { ...readIdentityMap(), ...after };
  for (const id of Object.keys(before)) {
    if (!(id in after)) delete merged[id];
  }
  writeIdentityMap(merged);
  return merged;
}

/**
 * Sort persisted terminal rows back into the buckets they were opened in.
 *
 * A row with no identity is deliberately dropped rather than defaulted into the
 * home bucket: defaulting is precisely how a project's VM shell came back as a
 * home shell (issue 394). Callers show nothing for those.
 */
export function restoreUserTerminals<T extends { id: string }>(
  terminals: readonly T[],
  identities: UserTerminalIdentityMap,
): Record<string, Array<{ terminal: T; identity: UserTerminalIdentity }>> {
  const byScope: Record<string, Array<{ terminal: T; identity: UserTerminalIdentity }>> = {};
  for (const terminal of terminals) {
    const identity = identities[terminal.id];
    if (!identity) continue;
    (byScope[identity.scopeKey] ??= []).push({ terminal, identity });
  }
  return byScope;
}
