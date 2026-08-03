// Dialer status for a Core connection.
//
// Surfaced from the Panel service (which owns the mTLS `ws` dial) to every
// open tab over the panel link (ADR 0012).
//
// Self-contained (no `~/` imports) so it compiles under both the Vite and
// the Harness's tsconfigs and can be shared across the panel link.

export type RemoteDialStatus =
  | { state: "disconnected"; coreId: string; error?: string }
  | { state: "connecting"; coreId: string }
  | { state: "authenticated"; coreId: string; exp: number; lastEventId: number }
  | {
      state: "auth-error";
      coreId: string;
      reason: "expired" | "bad-signature" | "malformed";
    };
