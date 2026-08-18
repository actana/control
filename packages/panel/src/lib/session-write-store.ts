// May this tab type into this Session — the browser's copy of the answer
// (issue 147, ADR 0024 D3/D8).
//
// A module store rather than React state, for the same reason the question
// store and the terminal store are: the answer arrives on a socket, is shared
// by every pane rendering that Session, and has to be readable from inside an
// xterm callback that was wired once when the surface was built and is not
// re-created on render.
//
// It holds the two facts separately, because they *are* separate (see
// `~/shared/session-write-access`): the **Session lock**, which is the Core's
// published answer for this whole Panel, and the **Session drive**, which is
// this tab's standing among the Panel's own tabs. Only the derived answer is
// combined, in one place, so no pane invents its own precedence.
//
// Nothing here polls and nothing here refetches. Both facts are pushed: the
// lock because D8 publishes it and the panel link relays it, the drive because
// the Panel arbitrates it. That is the whole point — read-only has to be on
// screen before a keystroke, and a keystroke is the one thing that must not be
// how the operator finds out.

import { useSyncExternalStore } from "react";
import { getPanelBridge } from "./panel-bridge";
import {
  UNSUPPORTED_SESSION_LOCK,
  sessionWriteAccess,
  type PanelSessionLock,
  type SessionDriveState,
  type SessionWriteAccess,
} from "~/shared/session-write-access";

export type SessionWriteState = {
  lock: PanelSessionLock;
  drive: SessionDriveState;
  access: SessionWriteAccess;
};

/**
 * What a Session reads as before anything has been heard about it: writable, on
 * a Core that has said nothing about locks, with nobody arbitrating.
 *
 * Optimistic on purpose, and it is the same optimism the Core itself has — an
 * unlocked Session is writable by anybody (D11), and a Panel that opened
 * read-only and waited for permission would be a Panel that renders every
 * Session on a single-connection Core as locked forever.
 */
const UNKNOWN: SessionWriteState = {
  lock: UNSUPPORTED_SESSION_LOCK,
  drive: "none",
  access: { writable: true },
};

type Entry = SessionWriteState;

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
/** Handover notices this tab has not shown yet, keyed like the entries. */
const handoverListeners = new Set<(msg: { coreId: string; taskId: string }) => void>();
let wired = false;

function key(coreId: string | null | undefined, taskId: string): string {
  return `${coreId ?? ""}/${taskId}`;
}

function emit(): void {
  for (const cb of listeners) cb();
}

function put(k: string, next: Omit<Entry, "access">): void {
  const before = entries.get(k);
  if (before && before.lock.state === next.lock.state && before.lock.supported === next.lock.supported && before.lock.writable === next.lock.writable && before.drive === next.drive) {
    return;
  }
  entries.set(k, { ...next, access: sessionWriteAccess(next) });
  emit();
}

/**
 * Start listening to the tab's panel link. Idempotent, and called from the read
 * paths rather than at module load: on the server there is no link to listen
 * to, and a store that wired itself on import would reach for one during SSR.
 */
function ensureWired(): void {
  if (wired) return;
  const bridge = getPanelBridge();
  if (!bridge) return;
  wired = true;
  bridge.onSessionLock(({ coreId, taskId, lock }) => {
    const k = key(coreId, taskId);
    const current = entries.get(k) ?? UNKNOWN;
    put(k, { lock, drive: current.drive });
  });
  bridge.onSessionDrive(({ coreId, taskId, driving, reason }) => {
    const k = key(coreId, taskId);
    const current = entries.get(k) ?? UNKNOWN;
    put(k, { lock: current.lock, drive: driving ? "driving" : "following" });
    // The loser of an intra-Panel handover. A different event from losing the
    // Session to another Core client, and it is announced on its own channel so
    // no call site can reach for the wrong copy: nothing was taken here, and
    // nothing was lost.
    if (!driving && reason === "handover") {
      for (const cb of handoverListeners) cb({ coreId, taskId });
    }
  });
}

/** Told when this tab stops driving a Session because it was taken in another tab. */
export function onSessionDriveHandover(
  cb: (msg: { coreId: string; taskId: string }) => void,
): () => void {
  ensureWired();
  handoverListeners.add(cb);
  return () => handoverListeners.delete(cb);
}

/** The current answer for one Session, without subscribing. */
export function readSessionWriteState(
  coreId: string | null | undefined,
  taskId: string,
): SessionWriteState {
  ensureWired();
  return entries.get(key(coreId, taskId)) ?? UNKNOWN;
}

/**
 * This tab has a pane open on a Session and will drive it if no other tab of
 * this Panel is (issue 147). Not a claim on the Session lock — that is an
 * explicit gesture over the core-link, and this one never leaves the Panel.
 */
export function watchSessionDrive(coreId: string | null | undefined, taskId: string): void {
  if (!coreId) return;
  ensureWired();
  getPanelBridge()?.driveSession(coreId, taskId);
}

/** The operator asked for the keyboard in this tab. Instant, and Panel-local. */
export function takeSessionDrive(coreId: string | null | undefined, taskId: string): void {
  if (!coreId) return;
  ensureWired();
  getPanelBridge()?.driveSession(coreId, taskId, { take: true });
}

/**
 * One of this tab's panes on a Session has gone.
 *
 * The local answer is reset only when it was the **last** pane (issue 186).
 * This entry is keyed by Session and shared by every pane rendering it, and the
 * drive it holds is the tab's standing, not the pane's — so clearing it because
 * one of two panes closed would tell the surviving pane that nobody arbitrates
 * a Session this tab is still watching. `none` reads as writable, which is the
 * silent half of a dual write: a pane typing on a drive it no longer holds,
 * with no read-only state on screen to say so.
 */
export function releaseSessionDrive(coreId: string | null | undefined, taskId: string): void {
  if (!coreId) return;
  // The pane count lives in the link client, which is the one thing that also
  // has to re-announce this tab's interest on a reconnect. Asked, not mirrored.
  if (getPanelBridge()?.releaseSessionDrive(coreId, taskId) !== true) return;
  const k = key(coreId, taskId);
  const current = entries.get(k);
  if (!current) return;
  put(k, { lock: current.lock, drive: "none" });
}

function subscribe(cb: () => void): () => void {
  ensureWired();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Whether this pane may write, and why not when it may not.
 *
 * One hook for both facts: a component that read them separately would have to
 * decide which wins, and the two answers deserve different sentences rather
 * than different orderings per call site.
 */
export function useSessionWriteState(
  coreId: string | null | undefined,
  taskId: string,
): SessionWriteState {
  return useSyncExternalStore(
    subscribe,
    () => entries.get(key(coreId, taskId)) ?? UNKNOWN,
    () => UNKNOWN,
  );
}

/** @internal — tests drive the store without a link. */
export function __setSessionWriteStateForTests(
  coreId: string | null,
  taskId: string,
  next: { lock: PanelSessionLock; drive: SessionDriveState } | null,
): void {
  const k = key(coreId, taskId);
  if (!next) {
    entries.delete(k);
    emit();
    return;
  }
  put(k, next);
}

/** @internal — tests start from an empty store. */
export function __resetSessionWriteStoreForTests(): void {
  entries.clear();
  handoverListeners.clear();
  wired = false;
  emit();
}
