import type { PanelSessionLock } from "~/shared/session-write-access";

/**
 * What the Panel's link knows about a Session's lock, for code outside the link (#962 `close_session` refuses a Session
 * someone is working in). `attachPanelLink` registers the router's answer; until then nothing is known.
 */
type Probe = (coreId: string, sessionId: string) => PanelSessionLock;
let probe: Probe | null = null;

export function setSessionLockProbe(p: Probe | null): void {
  probe = p;
}

/** True when a client (a Panel tab or a terminal) holds this Session's lock. False when it is free or the lock state is not known. */
export function sessionIsHeld(coreId: string, sessionId: string): boolean {
  const lock = probe?.(coreId, sessionId);
  return lock !== undefined && lock.supported && lock.state !== "unlocked";
}
