import { PanelLinkClient, type PanelLinkEventMessage } from "./panel-link-client";
import { corePtyBridgeFor, type CorePtyBridge } from "./core-pty-bridge";
import type {
  CoreLinkHarnessAvailabilityMap,
  CoreLinkHarnessInstallAck,
  CoreLinkSessionSnapshot,
  CoreLinkSessionMutation,
  CoreLinkSessionRow,
} from "@actana/shared/sdk-link-frames";
import type { CoreLinkAnswer as Answer } from "~/shared/panel-link";
import type { CoreDialStatus } from "~/shared/cores";
import type { PanelSessionLock } from "~/shared/session-write-access";

/**
 * The Panel UI's bridge — the one surface through which components reach a
 * Core.
 *
 * Every member below is a frame on the tab's panel link: the service holds the
 * core-link and the browser is genuinely a browser.
 *
 * Reads, terminals, and writes all ride the link. There is no second write
 * path: a mutation is a frame addressed to the Core that owns the row
 * (ADR 0004), so the Core is the only process that ever touches its own
 * database, and two tabs looking at the same Core see the same answer because
 * they asked the same machine.
 */
export type PanelBridge = {
  /** True while the tab's link is up. False during a reconnect. */
  isConnected(): boolean;

  /**
   * List a Core's active sessions. Live query — the Panel persists none of this.
   *
   * `archivedCount` is how many archived rows the Core holds — a scalar,
   * never the rows, which is what lets the Archived tab be gated and labelled
   * without an archived row crossing this answer (ADR 0019). Use
   * {@link listArchivedSessions} for the rows.
   */
  listSessionRows(
    coreId: string,
  ): Promise<{ sessions: CoreLinkSessionRow[]; archivedCount: number }>;
  /**
   * List a Core's archived sessions — the Archived view's own read path
   * (ADR 0019). Called when that view opens, not on Core open.
   */
  listArchivedSessions(coreId: string): Promise<CoreLinkSessionRow[]>;
  /** List a Core's live sessions, with the PTY each one is attached to. */
  listSessions(coreId: string): Promise<CoreLinkSessionSnapshot[]>;
  /** A Core's CLI availability snapshot; live changes arrive on {@link onEvent}. */
  listHarnessAvailability(coreId: string): Promise<CoreLinkHarnessAvailabilityMap>;
  /**
   * Ask a Core to install a Harness its probe reports missing.
   *
   * Resolves on the Core's *ack* — that it took the job — and never on the
   * install's outcome: a vendor installer runs for minutes, well past this
   * link's per-request timeout. The outcome arrives on {@link onEvent}, as an
   * availability change flipping the Harness to `available` or as a
   * `harness:installFailed` event. `accepted: false` is a refusal to start,
   * carrying the reason to show the operator.
   */
  installHarness(coreId: string, harness: string): Promise<CoreLinkHarnessInstallAck>;

  /** Create / update a session on the Core that owns it. */
  mutateSession(coreId: string, mutation: CoreLinkSessionMutation): Promise<CoreLinkSessionRow | null>;

  /**
   * Watch a Core's live stream for as long as the returned function is unused.
   * Nothing arrives on {@link onEvent} for a Core nobody is watching — a tab
   * looking at one Core does not pay for the rest of the fleet.
   */
  watchCore(coreId: string): () => void;
  /**
   * Domain events from every watched Core, tagged with their owner — and with
   * whether they answered a subscribe this tab sent having seen nothing
   * (issue 388).
   */
  onEvent(cb: (msg: PanelLinkEventMessage) => void): () => void;
  /** Dial-status changes, pushed by the service as it finds them. */
  onDialStatus(cb: (status: CoreDialStatus) => void): () => void;
  // ─── Session write access (issue 147, ADR 0024 D3/D8) ───
  // Two things, kept apart on purpose. `claimSession` / `releaseSessionLock` /
  // `forceTakeoverSession` are the **Session lock**: core-link frames, answered
  // by the Core, held by the Panel *once* for all of its tabs. `driveSession` /
  // `releaseSessionDrive` are the **Session drive**: which of this Panel's tabs
  // holds the keyboard, settled inside the Panel and sent to no Core.

  /**
   * Claim this Session's write lock for the Panel. `granted: false` means
   * another Core client holds it — an answer, not a failure, and the only way
   * past it is {@link forceTakeoverSession}.
   *
   * `supported: false` says this Core has no lock table at all. **It must never
   * render read-only**: it is the opposite of `granted: false`, and conflating
   * them makes a single-connection Core look permanently locked to the operator
   * who is its only client.
   */
  claimSession(coreId: string, sessionId: string): Promise<{ supported: boolean; granted: boolean }>;
  /** Give this Session's write lock back. Idempotent — the Panel may not hold it. */
  releaseSessionLock(coreId: string, sessionId: string): Promise<{ released: boolean }>;
  /**
   * Take this Session's write lock whoever holds it. Unconditional and
   * unrecoverable by design (ADR 0024 D7): the previous holder's in-flight
   * keystrokes are gone. `takenFrom` says whether anybody was actually evicted,
   * so a caller never reports an eviction that did not happen.
   */
  forceTakeoverSession(
    coreId: string,
    sessionId: string,
  ): Promise<{ takenFrom: "nobody" | "another-connection" | "this-connection" }>;
  /**
   * This tab has a pane open on a Session, and drives it if no other tab of this
   * Panel does. `take` is the operator asking for the keyboard here, which moves
   * it off whichever tab of this Panel had it — a Panel-local handover that
   * costs nobody their Session and crosses no wire.
   *
   * Counted over this tab's panes, so a second pane on the same Session says
   * nothing on the wire (issue 186). `take` is exempt: it is a gesture, not a
   * pane.
   */
  driveSession(coreId: string, sessionId: string, opts?: { take?: boolean }): void;
  /**
   * One of this tab's panes on a Session has gone. Returns whether it was the
   * last one — whether the tab gave the Session back, or still has it on screen
   * in another pane (issue 186).
   */
  releaseSessionDrive(coreId: string, sessionId: string): boolean;
  /** The Session lock as the service's link to that Core sees it, pushed on change. */
  onSessionLock(
    cb: (msg: { coreId: string; sessionId: string; lock: PanelSessionLock }) => void,
  ): () => void;
  /** Whether this tab drives a Session, pushed on change. */
  onSessionDrive(
    cb: (msg: {
      coreId: string;
      sessionId: string;
      driving: boolean;
      reason: "watch" | "handover";
    }) => void,
  ): () => void;

  /** Link up / link down, so a view can refetch across a gap. */
  onConnectionChange(cb: (connected: boolean) => void): () => void;

  /**
   * A Core's PTY transport — spawn, keystrokes, resize, kill, replay, and the
   * output stream. Stable per Core, so every terminal on that Core shares one
   * subscription and one reconnect reattach (see {@link CorePtyBridge}).
   */
  pty(coreId: string): CorePtyBridge;
};

function makeBridge(link: PanelLinkClient): PanelBridge {
  return {
    isConnected: () => link.isConnected(),
    listSessionRows: async (coreId) => {
      const result = await link.request<Answer<"sessionRowsListResult">>(coreId, {
        type: "sessionRowsList",
      });
      return { sessions: result.sessions, archivedCount: result.archivedCount };
    },
    listArchivedSessions: async (coreId) =>
      (
        await link.request<Answer<"archivedSessionRowsListResult">>(coreId, {
          type: "archivedSessionRowsList",
        })
      ).sessions,
    listSessions: async (coreId) =>
      (await link.request<Answer<"sessionsListResult">>(coreId, { type: "sessionsList" })).sessions,
    listHarnessAvailability: async (coreId) =>
      (
        await link.request<Answer<"agentsAvailabilityListResult">>(coreId, {
          type: "agentsAvailabilityList",
        })
      ).availability,
    installHarness: async (coreId, harness) => {
      const ack = await link.request<Answer<"harnessInstallAck">>(coreId, {
        type: "harnessInstall",
        harness,
      });
      return { accepted: ack.accepted, message: ack.message };
    },
    mutateSession: async (coreId, mutation) =>
      (await link.request<Answer<"sessionsMutateResult">>(coreId, { type: "sessionsMutate", mutation }))
        .session,
    watchCore: (coreId) => link.watch(coreId),
    onEvent: (cb) => link.onEvent(cb),
    onDialStatus: (cb) => link.onDialStatus(cb),
    onConnectionChange: (cb) => link.onConnectionChange(cb),
    // The Session lock's three gestures are ordinary core-link frames, so they
    // ride `request` like every other mutation — the Panel is a router, and
    // there is no second vocabulary for them. `supported` is read off the
    // service's own answer: a Core with no lock table answers the claim frame
    // with an error, and the router's register never reports anything but
    // `supported: false` for it, so a claim there resolves to what it is —
    // nothing to claim, and nothing stopping the write either.
    claimSession: async (coreId, sessionId) => {
      try {
        const result = await link.request<Answer<"claimResult">>(coreId, { type: "claim", sessionId });
        return { supported: true, granted: result.granted };
      } catch {
        return { supported: false, granted: false };
      }
    },
    releaseSessionLock: async (coreId, sessionId) => {
      try {
        const result = await link.request<Answer<"releaseResult">>(coreId, {
          type: "release",
          sessionId,
        });
        return { released: result.released };
      } catch {
        return { released: false };
      }
    },
    forceTakeoverSession: async (coreId, sessionId) => {
      const result = await link.request<Answer<"forceTakeoverResult">>(coreId, {
        type: "forceTakeover",
        sessionId,
      });
      return { takenFrom: result.takenFrom };
    },
    driveSession: (coreId, sessionId, opts) => link.driveSession(coreId, sessionId, opts),
    releaseSessionDrive: (coreId, sessionId) => link.releaseSessionDrive(coreId, sessionId),
    onSessionLock: (cb) => link.onSessionLock(cb),
    onSessionDrive: (cb) => link.onSessionDrive(cb),
    pty: (coreId) => corePtyBridgeFor(link, coreId),
  };
}

let singleton: PanelBridge | null = null;

/**
 * The tab's bridge. Null while server-rendering, where there is no socket to
 * hold and no live data to show.
 */
export function getPanelBridge(): PanelBridge | null {
  if (typeof window === "undefined") return null;
  if (!singleton) singleton = makeBridge(new PanelLinkClient());
  return singleton;
}

/**
 * The PTY transport for one Core, or `null` when there is no Core to address
 * or no link to carry it (server rendering).
 */
export function getCorePtyBridge(coreId: string | null | undefined): CorePtyBridge | null {
  // No Core, no transport. A pane with no `coreId` has no machine to run on —
  // there is no local Core to fall back to (ADR 0010).
  if (!coreId) return null;
  return getPanelBridge()?.pty(coreId) ?? null;
}

/** @internal — tests that need a bridge over a fake link. */
export function __setPanelBridgeForTests(bridge: PanelBridge | null): void {
  singleton = bridge;
}

/** @internal — the bridge over an explicitly provided link (tests, tooling). */
export function createPanelBridge(link: PanelLinkClient): PanelBridge {
  return makeBridge(link);
}
