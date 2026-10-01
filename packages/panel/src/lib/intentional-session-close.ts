/** Session ids whose PTY is being torn down on purpose (archive, delete, Core close). */
const intentional = new Set<string>();

export function markIntentionalSessionClose(sessionId: string): void {
  intentional.add(sessionId);
}

/** Returns true once per marked close; used to skip auto-delete on PTY exit. */
export function consumeIntentionalSessionClose(sessionId: string): boolean {
  if (!intentional.has(sessionId)) return false;
  intentional.delete(sessionId);
  return true;
}

/** Test helper — not used in production paths. */
export function clearIntentionalSessionCloses(): void {
  intentional.clear();
}
