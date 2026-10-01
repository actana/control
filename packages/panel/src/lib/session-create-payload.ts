import type { Harness } from "@actana/shared/domain";
import type { CoreRememberSettings } from "~/lib/core-remember";

/** What a new Session is created with: the harness, and whether Claude Code runs bare. */
export type SessionCreatePayload = {
  agent: Harness;
  bareSession: boolean;
};

/**
 * The payload "New Session" uses when it does not ask: the harness remembered for
 * the Core, or Claude Code. Remembered settings carry no bare-session choice, so
 * a session started this way is never bare.
 */
export function defaultSessionPayload(
  remembered: Pick<CoreRememberSettings, "savedHarness">,
): SessionCreatePayload {
  return { agent: remembered.savedHarness ?? "claude-code", bareSession: false };
}
