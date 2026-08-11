// The panel link — the one WebSocket a browser tab holds to the Panel service.
//
// One tab, one socket, however many Cores are registered (ADR 0012). Everything
// live the browser sees arrives here: PTY output, Core events, dial-status
// changes. Everything live it asks for goes out here: queries, mutations, PTY
// input.
//
// The framing is deliberately thin. A panel-link frame is a core-link frame in
// a `coreId` envelope — the Panel is a *router*, not a translator, so there is
// no second vocabulary to keep in sync with the Core. The only frames that
// are not core-link frames are the ones describing facts the Core has no
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
import type { PanelSessionLock } from "~/shared/session-write-access";

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
 *
 * Issue 147's `lock` and `drive` frames do not move it, and the test is the one
 * the core-link's own additive rule uses: the absence of the new frames has to
 * yield exactly today's behaviour, not a lesser one. A tab left open across a
 * Panel upgrade never sends `drive`, so it is never arbitrated against and
 * never rendered read-only — it types into Sessions exactly as it did this
 * morning — and it drops the `lock` frames it does not recognise on the floor,
 * because {@link decodeServerFrame} answers null for an unknown `t` and the
 * client ignores that. Both halves ship from one build, so the reverse pairing
 * (a new tab against an old service) is not a state this can reach.
 */
export const PANEL_LINK_PROTOCOL_VERSION = 1;

/** Upgrade query parameter carrying {@link PANEL_LINK_PROTOCOL_VERSION}. */
export const PANEL_LINK_VERSION_PARAM = "v";

/**
 * Frames the Core pushes without being asked, forwarded verbatim under the
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
 *
 * `drive` is the other kind of frame, and the second member of the short list
 * this module opened with: a fact the Core has no opinion about. Which of this
 * Panel's tabs drives a Session is settled between Panel sessions inside the
 * Panel (ADR 0024 D3) — it is not the Session lock, the Core never hears of it,
 * and there is deliberately no core-link frame to reuse for it. The lock itself
 * is claimed, released and force-taken with ordinary `core` frames, because
 * those *are* core-link frames and the Panel is a router.
 */
export type PanelLinkClientFrame =
  | {
      t: "core";
      coreId: string;
      frame: CoreLinkRequestFrame;
    }
  | {
      t: "drive";
      coreId: string;
      taskId: string;
      /**
       * `watch` — this tab has the Session on screen and will drive it if
       * nobody else in this Panel is (first-come). `take` — the operator asked
       * for the keyboard here, so move it. `drop` — this pane is gone.
       */
      want: "watch" | "take" | "drop";
    };

/**
 * Panel → browser.
 *
 * `core` carries a core-link response or push frame back under its `coreId`.
 * `dial` is the one panel-owned fact: whether the service can reach that Core
 * right now. The Core cannot report its own unreachability, so this has no
 * core-link equivalent to reuse.
 */
export type PanelLinkServerFrame =
  | { t: "core"; coreId: string; frame: CoreLinkResponseFrame | CoreLinkPushFrame }
  | { t: "dial"; status: CoreDialStatus }
  // ─── Session write access (issue 147, ADR 0024 D3/D8) ───
  // Two frames, because they carry two different facts, and a browser that had
  // to guess which one a merged frame was about would be the ambiguity this
  // effort's traps are written against.
  //
  // `lock` is the **Session lock**, Core-scoped: the Core's own published
  // answer for the connection the service holds, relayed to every tab watching
  // that Core because they all share it. Not per tab, and not derived here —
  // see the lock register.
  //
  // `drive` is the **Session drive**, Panel-scoped and per tab: whether *this*
  // tab holds the keyboard for that Session among this Panel's tabs. It never
  // crosses a core-link and no Core has an opinion about it.
  | { t: "lock"; coreId: string; taskId: string; lock: PanelSessionLock }
  | {
      t: "drive";
      coreId: string;
      taskId: string;
      driving: boolean;
      /**
       * Why this tab is being told. `handover` means the drive moved while this
       * tab was watching — the operator took the keyboard in another tab of this
       * Panel — and it is the one case a tab says something to the operator
       * about it. It is **not** a force takeover: nothing was taken from
       * anybody, nothing was lost, and the copy for the two must not be shared.
       */
      reason: "watch" | "handover";
    };

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
  if (!msg) return null;
  if (msg.t === "drive") {
    const coreId = typeof msg.coreId === "string" ? msg.coreId : "";
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const want = msg.want;
    if (!coreId || !taskId) return null;
    if (want !== "watch" && want !== "take" && want !== "drop") return null;
    return { t: "drive", coreId, taskId, want };
  }
  if (msg.t !== "core") return null;
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
  if (msg.t === "lock") {
    const coreId = typeof msg.coreId === "string" ? msg.coreId : "";
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const lock = msg.lock as Partial<PanelSessionLock> | undefined;
    const state = lock?.state;
    if (!coreId || !taskId || !lock) return null;
    if (state !== "unlocked" && state !== "held-by-you" && state !== "held-by-another") return null;
    return {
      t: "lock",
      coreId,
      taskId,
      lock: {
        supported: lock.supported === true,
        // Read from the state when the flag is missing, never defaulted to
        // false. Which states are writable is a Core-side rule and the flag is
        // how it travels — but a frame that lost it must not turn a Session
        // nobody holds into a read-only one, which is the single worst thing
        // this field can be wrong about (see `session-write-access`).
        writable: typeof lock.writable === "boolean" ? lock.writable : state !== "held-by-another",
        state,
      },
    };
  }
  if (msg.t === "drive") {
    const coreId = typeof msg.coreId === "string" ? msg.coreId : "";
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    if (!coreId || !taskId) return null;
    return {
      t: "drive",
      coreId,
      taskId,
      driving: msg.driving === true,
      reason: msg.reason === "handover" ? "handover" : "watch",
    };
  }
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
