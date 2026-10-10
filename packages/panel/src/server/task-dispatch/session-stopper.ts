import { coreLinkManager } from "../services/core-link-manager";
import type { CoreClient } from "@actana/sdk/core";
import { messageOf, type SessionStopper } from "./types";

/**
 * Stop a Task's Session on its Core (#723) through the Panel's own link: find the
 * Session's PTY and kill it. The Core settles the Session row itself when the PTY
 * exits (`onSessionExit` in the Core's PTY manager), so nothing else is written.
 *
 * Outcomes, never a throw:
 * - `unreachable`: no live link to the Core, or the whole call took over {@link STOP_TIMEOUT_MS};
 * - `not-running`: the Core has no PTY for the Session (it already ended);
 * - `stopped`: the PTY was killed;
 * - `failed`: the Core refused or errored; `detail` says how.
 * A Session another client holds the lock on (`session-locked`) is taken over once
 * and the kill is tried a second time: an operator's explicit stop outranks a lock.
 */

export const STOP_TIMEOUT_MS = 10_000;
const SESSION_LOCKED = "session-locked";

type LinkFor = (coreId: string) => { readonly sdk?: Pick<CoreClient, "findBySession" | "kill" | "forceTakeover"> } | null;

const defaultLinkFor: LinkFor = (coreId) => coreLinkManager().client(coreId);

export async function stopSessionOnCore(
  target: { coreId: string; sessionId: string },
  linkFor: LinkFor = defaultLinkFor,
  timeoutMs: number = STOP_TIMEOUT_MS,
): ReturnType<SessionStopper> {
  const sdk = linkFor(target.coreId)?.sdk;
  if (!sdk) return { outcome: "unreachable", detail: "there is no live link to this Core" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ outcome: "unreachable"; detail: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ outcome: "unreachable", detail: `the Core did not answer within ${Math.round(timeoutMs / 1000)} seconds` }),
      timeoutMs,
    );
  });
  const attempt = (async (): ReturnType<SessionStopper> => {
    const { ptyId } = await sdk.findBySession(target.sessionId);
    if (!ptyId) return { outcome: "not-running", detail: null };
    try {
      return await killed(await sdk.kill(ptyId));
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== SESSION_LOCKED) throw err;
    }
    await sdk.forceTakeover(target.sessionId);
    return killed(await sdk.kill(ptyId));
  })().catch((err): { outcome: "failed"; detail: string } => ({ outcome: "failed", detail: messageOf(err) }));
  try {
    return await Promise.race([attempt, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function killed(ok: boolean): { outcome: "stopped" | "failed"; detail: string | null } {
  return ok ? { outcome: "stopped", detail: null } : { outcome: "failed", detail: "the Core did not kill the Session's process" };
}
