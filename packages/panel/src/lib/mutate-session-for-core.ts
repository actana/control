import type {
  CoreLinkSessionMutation,
  CoreLinkSessionRow,
} from "@actana/shared/sdk-link-frames";
import { getPanelBridge } from "~/lib/panel-bridge";

/**
 * Send a session mutation to the Core that owns the row (ADR 0005).
 *
 * There is one transport: the mutation is a frame on this tab's panel link,
 * addressed to a `coreId`, and the Core that answers is the only process that
 * writes its own database (ADR 0004). Callers name the Core; they never learn
 * how it is reached.
 *
 * Throws on transport failure or a Core-side error frame so the caller can
 * surface it in the picker/dialog. Returns `null` when the mutation targeted a
 * missing row.
 */
export async function mutateSessionForCore(
  coreId: string,
  mutation: CoreLinkSessionMutation,
): Promise<CoreLinkSessionRow | null> {
  const bridge = getPanelBridge();
  if (!bridge) throw new Error("Not connected to the Panel — cannot mutate session");
  return bridge.mutateSession(coreId, mutation);
}
