// What a `session kill` leaves behind (issue 292).
//
// A kill is a teardown, and a teardown on its own says nothing: the harness
// gets a hang-up, may catch it and exit 0, and the row then reads exactly like
// a Session whose work completed. So the Core records the request on the PTY
// before it tears it down, settles the row from that record when the exit
// arrives, and appends one `session:killed` event a caller who was not there
// can read afterwards. Kept apart from `pty-manager.ts` so the core-link
// server can name the reason without loading node-pty.

/** Who asked for a PTY to die, and when. */
export type PtySessionKill = {
  /** Epoch milliseconds at which the kill was requested. */
  at: number;
  /** A sentence for a caller who was not there when it happened. */
  reason: string;
};

/** The reason recorded for a kill a core-link client asked for. */
export const CLIENT_KILL_REASON = "killed by a client request (session kill)";

/**
 * Appended once per killed Session, when its process has gone — whether or not
 * a Panel is connected, the same rule the exit settle holds itself to.
 */
export const SESSION_KILLED_EVENT_KIND = "session:killed";

/** Payload of a {@link SESSION_KILLED_EVENT_KIND} event. */
export type SessionKilledPayload = {
  sessionId: string;
  ptyId: string;
  /** Why it was killed; {@link CLIENT_KILL_REASON} for a client's kill. */
  reason: string;
  /** ISO 8601 time the kill was requested. */
  killedAt: string;
  /** True when a turn was in flight (`running` / `needs-input`) at the exit. */
  liveTurn: boolean;
  /** The row's status just before the exit settled it, or `null` with no row. */
  statusBefore: string | null;
  /** The row's status after the settle, or `null` with no row. */
  status: string | null;
  exitCode: number;
  /** The signal that ended the process, or `null` when none did. */
  signal: number | null;
};
