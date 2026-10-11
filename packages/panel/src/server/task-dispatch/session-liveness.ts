import { coreLinkManager } from "../services/core-link-manager";
import type { CoreClient } from "@actana/sdk/core";
import type { SessionLiveness } from "./types";

/**
 * Which Sessions are live on a Core (#724), through the Panel's own link: one `sessionsList` call per Core, keeping
 * the Sessions the Core has a live PTY for. `null` is "no answer" (no link, an error, or no reply within
 * {@link LIVENESS_TIMEOUT_MS}); it never throws, and the watcher treats it as "nothing changed".
 */

export const LIVENESS_TIMEOUT_MS = 10_000;

type LinkFor = (coreId: string) => { readonly sdk?: Pick<CoreClient, "sessionsList"> } | null;

const defaultLinkFor: LinkFor = (coreId) => coreLinkManager().client(coreId);

export async function liveSessionsOnCore(
  coreId: string,
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
    const listed = (async () => new Set((await sdk.sessionsList()).filter((s) => s.ptyId !== null).map((s) => s.sessionId)))().catch(() => null);
    return await Promise.race([listed, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
