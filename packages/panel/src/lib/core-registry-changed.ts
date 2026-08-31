import { CORE_REGISTRY_CHANGED_EVENT } from "~/lib/design-meta";

/**
 * "The Core registry just changed — ask again."
 *
 * The registry only ever changes because an operator paired a Core or forgot
 * one, so the read paths that watch it poll slowly (`useCores`, fifteen
 * seconds), which is right for a list and wrong for a gate. The first-run gate
 * decides whether this Panel shows a dashboard at all; up to fifteen seconds of
 * wizard after a pairing landed, or of dashboard after the last Core was
 * forgotten, is the gate being wrong about the only thing it decides.
 *
 * So the two gestures that change the registry say so, and whoever is watching
 * re-reads. This is a nudge, not a channel: nothing is carried and nothing is
 * cached, because the answer to "how many Cores are there" belongs to the
 * server and a count riding an event would be a second source of truth for the
 * one number the gate must not be wrong about. The event says *ask again*.
 *
 * Window-scoped, so it reaches every component in this tab and no further.
 * Another tab's pairing is picked up by the poll, as it always was.
 */
export function announceCoreRegistryChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CORE_REGISTRY_CHANGED_EVENT));
}

/** Listen for {@link announceCoreRegistryChanged}. Returns the unsubscribe. */
export function onCoreRegistryChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(CORE_REGISTRY_CHANGED_EVENT, listener);
  return () => window.removeEventListener(CORE_REGISTRY_CHANGED_EVENT, listener);
}
