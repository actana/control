import type { PanelBridge } from "~/lib/panel-bridge";
import type { CoreLinkEvent } from "@actana/shared/core-link-frames";

// A Core's projectsList result changes when the Harness appends one of these
// event kinds to its monotonic event log. Everything else (task lifecycle,
// PTY spawn/exit, hook, session) leaves projects untouched — filtering here
// keeps refetches proportional to the mutation surface `useCoreProjects`
// actually cares about.
const PROJECT_EVENT_KINDS = new Set([
  "project:created",
  "project:renamed",
  "project:archived",
  // Pin is a Harness fact stored on the project row; a change fans out via
  // this dedicated kind. Every mounted `useCoreProjects` refetches so two
  // Panels on the same Core end up with the same pin state.
  "project:pinnedChanged",
]);

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
    if (PROJECT_EVENT_KINDS.has(msg.event.kind)) onChanged();
  });
}

export type { CoreLinkEvent };
