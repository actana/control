import type { PanelBridge } from "~/lib/panel-bridge";
import type { CoreLinkEvent } from "@actana/sdk/core-link-frames";

// A Core's projectsList result changes when the Core appends one of these
// event kinds to its monotonic event log. Everything else (task lifecycle,
// PTY spawn/exit, hook, session) leaves projects untouched — filtering here
// keeps refetches proportional to the mutation surface `useCoreProjects`
// actually cares about.
const PROJECT_EVENT_KINDS = new Set([
  "project:created",
  "project:renamed",
  "project:archived",
  // Pin is a Core fact stored on the project row; a change fans out via
  // this dedicated kind. Every mounted `useCoreProjects` refetches so two
  // Panels on the same Core end up with the same pin state.
  "project:pinnedChanged",
  // Remembered session settings and the grid-view default are Core facts too
  // (issue 22), and they change what the New session button does — a Panel
  // that missed the change would keep opening the dialog it should skip.
  "project:settingsChanged",
  // Icon and icon colour are Core facts on the project row too (issue 98), and
  // they are what the project reads as in the rail and on its card — a Panel
  // that missed the change would keep drawing the old badge.
  "project:appearanceChanged",
]);

/**
 * Does this event kind change what a `projectsList` would return?
 *
 * Exported for the callers that already hold their own `onEvent` subscription
 * and cannot afford a second one — the rail's pinned-projects engine watches
 * project and task kinds through one handler — so the answer to "which kinds
 * move a project row" stays in this file rather than being re-listed there.
 */
export function isProjectListEventKind(kind: string): boolean {
  return PROJECT_EVENT_KINDS.has(kind);
}

/**
 * Invoke `onChanged` whenever the named Core reports a project-list-affecting
 * event on the tab's panel link.
 *
 * Every Core's events arrive on the same socket, tagged with their owner, so
 * this is one filter rather than one subscription per transport. The caller is
 * responsible for holding a `watchCore` for the same Core — a Core nobody
 * watches sends nothing.
 *
 * Returns an unsubscribe function; a no-op stub when `bridge` or `coreId` is
 * falsy so callers can wire the effect unconditionally.
 */
export function subscribeCoreProjectEvents(
  bridge: PanelBridge | null,
  coreId: string | null,
  onChanged: () => void,
): () => void {
  if (!bridge || !coreId) return () => {};
  return bridge.onEvent((msg) => {
    if (msg.coreId !== coreId) return;
    if (isProjectListEventKind(msg.event.kind)) onChanged();
  });
}

export type { CoreLinkEvent };
