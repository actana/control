import { coreLinkManager } from "../services/core-link-manager";
import type { CoreClient } from "@actana/sdk/core";
import type { SessionLiveness } from "./types";

/**
 * Which of the given Sessions are live on a Core (#724), through the Panel's own link: one `findBySession` call per
 * Session, against the Core's in-memory PTY table (as the stopper does), keeping the Sessions with a PTY. A null
 * `ptyId` is a miss. `sessionsList` is not used: a reachable Core answers it with `[]` when its SQLite read fails or
 * it has no mutation port, which would read as "nothing live". `null` is "no answer" (no link, any probe that
 * throws, or no reply from all probes within {@link LIVENESS_TIMEOUT_MS}); it never throws, and the watcher treats it
 * as "nothing changed".
 */

export const LIVENESS_TIMEOUT_MS = 10_000;

type LinkFor = (coreId: string) => { readonly sdk?: Pick<CoreClient, "findBySession"> } | null;

const defaultLinkFor: LinkFor = (coreId) => coreLinkManager().client(coreId);

export async function liveSessionsOnCore(
  coreId: string,
  sessionIds: readonly string[],
  linkFor: LinkFor = defaultLinkFor,
  timeoutMs: number = LIVENESS_TIMEOUT_MS,
): ReturnType<SessionLiveness> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sdk = linkFor(coreId)?.sdk;
    if (!sdk) return null;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const probed = Promise.all(sessionIds.map(async (id) => ((await sdk.findBySession(id)).ptyId !== null ? id : null)))
      .then((found) => new Set(found.filter((id): id is string => id !== null)) as ReadonlySet<string>)
      .catch(() => null);
    return await Promise.race([probed, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
