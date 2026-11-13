import { coreLinkManager } from "../services/core-link-manager";
import type { CoreClient } from "@actana/sdk/core";
import type { SessionStatusReader } from "./types";

/**
 * The Core's status for the given Sessions (#949), through the Panel's own link: one `sessionsList` call against the
 * Core, keeping the asked-for Sessions it lists. A Task adopted at Panel boot has no `CoreSession` handle to hear
 * `onStatus` on, so this is how it learns what its Session is doing. A Session the Core does not list is absent from
 * the map. `null` is "no answer" (no link, the list throws, or no reply within {@link STATUS_TIMEOUT_MS}); it never
 * throws, and the watcher treats it as "nothing changed".
 */

export const STATUS_TIMEOUT_MS = 10_000;

type LinkFor = (coreId: string) => { readonly sdk?: Pick<CoreClient, "sessionsList"> } | null;

const defaultLinkFor: LinkFor = (coreId) => coreLinkManager().client(coreId);

export async function sessionStatusesOnCore(
  coreId: string,
  sessionIds: readonly string[],
  linkFor: LinkFor = defaultLinkFor,
  timeoutMs: number = STATUS_TIMEOUT_MS,
): ReturnType<SessionStatusReader> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sdk = linkFor(coreId)?.sdk;
    if (!sdk) return null;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const wanted = new Set(sessionIds);
    const listed = sdk
      .sessionsList()
      .then((rows) => new Map(rows.filter((r) => wanted.has(r.sessionId)).map((r) => [r.sessionId, r.status] as const)) as ReadonlyMap<string, string>)
      .catch(() => null);
    return await Promise.race([listed, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
