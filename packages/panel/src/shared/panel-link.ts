// The panel link — the one WebSocket a browser tab holds to the Panel service.
//
// One tab, one socket, however many Cores are registered (ADR 0012). Everything
// live the browser sees arrives here: PTY output, Harness events, dial-status
// changes. Everything live it asks for goes out here: queries, mutations, PTY
// input.
//
// The framing is deliberately thin. A panel-link frame is a core-link frame in
// a `coreId` envelope — the Panel is a *router*, not a translator, so there is
// no second vocabulary to keep in sync with the Harness. The only frames that
// are not core-link frames are the ones describing facts the Harness has no
// opinion about: whether the Panel can currently reach a Core at all.
//
// This module is imported by both halves of the panel package — the service's
// router and the browser's client — so a change to a frame shape breaks the
// build on both sides at once, which is the point.

import type {
  CoreLinkEventFrame,
  CoreLinkEventsReplayedFrame,
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
  CoreLinkStreamFrame,
} from "@actana/shared/core-link-frames";
import type { CoreDialStatus } from "~/shared/cores";

/**
 * The answer frame a given core-link request resolves to. Both halves of the
 * link name their expected answer through this, so a caller that asks for the
 * wrong shape fails to compile rather than at runtime.
 */
export type CoreLinkAnswer<T extends CoreLinkResponseFrame["type"]> = Extract<
  CoreLinkResponseFrame,
  { type: T }
>;

/** Where the Panel service accepts panel-link upgrades. */
export const PANEL_LINK_PATH = "/panel-link";

/**
 * Bumped when a frame shape changes incompatibly. The browser sends the version
 * it was built with in the upgrade query; a service that doesn't recognise it
 * refuses the upgrade rather than speaking half a protocol at a stale tab that
 * a hard reload would fix.
 */
export const PANEL_LINK_PROTOCOL_VERSION = 1;

/** Upgrade query parameter carrying {@link PANEL_LINK_PROTOCOL_VERSION}. */
export const PANEL_LINK_VERSION_PARAM = "v";

/**
 * Frames the Harness pushes without being asked, forwarded verbatim under the
 * `coreId` envelope: PTY output, PTY exit, domain events, end-of-replay.
 */
export type CoreLinkPushFrame =
  | CoreLinkStreamFrame
  | CoreLinkEventFrame
  | CoreLinkEventsReplayedFrame;

/**
 * Browser → Panel.
 *
 * `core` is the whole fan-out surface: any core-link request frame, addressed
 * to one registered Core. Most are forwarded down that Core's core-link
 * untouched. `subscribe` is the exception — the service answers it from its own
 * replay buffer, because the *service* holds the core-link and the browser is
 * one of possibly several tabs watching it (see the router).
 */
export type PanelLinkClientFrame = {
  t: "core";
  coreId: string;
  frame: CoreLinkRequestFrame;
};

/**
 * Panel → browser.
 *
 * `core` carries a core-link response or push frame back under its `coreId`.
 * `dial` is the one panel-owned fact: whether the service can reach that Core
 * right now. The Harness cannot report its own unreachability, so this has no
 * core-link equivalent to reuse.
 */
export type PanelLinkServerFrame =
  | { t: "core"; coreId: string; frame: CoreLinkResponseFrame | CoreLinkPushFrame }
  | { t: "dial"; status: CoreDialStatus };

export function encodePanelLinkFrame(
  frame: PanelLinkClientFrame | PanelLinkServerFrame,
): string {
  return JSON.stringify(frame);
}

/**
 * Parse a frame arriving from the browser. Anything malformed reads as `null`
 * rather than throwing: a socket carrying one bad frame is not a socket worth
 * dropping, and a router that throws on parse hands a tab a denial of service.
 */
export function decodeClientFrame(raw: unknown): PanelLinkClientFrame | null {
  const msg = parseObject(raw);
  if (!msg || msg.t !== "core") return null;
  const coreId = typeof msg.coreId === "string" ? msg.coreId : "";
  if (!coreId) return null;
  const frame = msg.frame;
  if (!frame || typeof frame !== "object") return null;
  const { type, reqId } = frame as { type?: unknown; reqId?: unknown };
  if (typeof type !== "string" || typeof reqId !== "string" || !reqId) return null;
  return { t: "core", coreId, frame: frame as CoreLinkRequestFrame };
}

/** Parse a frame arriving from the service. Same forgiving contract. */
export function decodeServerFrame(raw: unknown): PanelLinkServerFrame | null {
  const msg = parseObject(raw);
  if (!msg) return null;
  if (msg.t === "dial") {
    const status = msg.status as CoreDialStatus | undefined;
    if (!status || typeof status.coreId !== "string" || typeof status.state !== "string") {
      return null;
    }
    return { t: "dial", status };
  }
  if (msg.t === "core") {
    const coreId = typeof msg.coreId === "string" ? msg.coreId : "";
    const frame = msg.frame;
    if (!coreId || !frame || typeof frame !== "object") return null;
    if (typeof (frame as { type?: unknown }).type !== "string") return null;
    return { t: "core", coreId, frame: frame as CoreLinkResponseFrame | CoreLinkPushFrame };
  }
  return null;
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  } else if (raw instanceof Uint8Array) {
    try {
      value = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * An error answer for a request the service could not route — no such Core, or
 * a Core whose link is down. Deliberately a core-link `error` frame: a caller
 * awaiting a reqId must not have to learn a second failure shape depending on
 * which hop failed.
 */
export function coreLinkError(reqId: string, message: string): CoreLinkResponseFrame {
  return { type: "error", reqId, message };
}
