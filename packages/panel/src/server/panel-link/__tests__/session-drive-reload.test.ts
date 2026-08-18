import { beforeEach, describe, expect, it } from "vitest";
import type {
  CoreLinkEvent,
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
} from "@actana/sdk/core-link-frames";
import type { CoreDialStatus } from "~/shared/cores";
import type { CoreLinkClientLike } from "../../services/core-link-manager";
import { PanelLinkRouter, type CoreLinkSource } from "../router";
import type { PanelLinkServerFrame } from "~/shared/panel-link";

/**
 * Issue 242's done-when, asserted where a browser could observe it: what the
 * service writes to a returning tab's socket.
 *
 * The scenario the ticket is about is one tab and one Session. The tab reloads;
 * its predecessor socket is *still attached*, because a reverse proxy or
 * Docker's NAT routinely delays a `close` — which is why every reload test here
 * retires the predecessor explicitly afterwards rather than before, and why
 * `attach` is called while the old session is still live. On loopback the close
 * usually lands first, and that ordering is covered too: both have to end with
 * the operator holding their keyboard.
 *
 * As in issue 147's suite, nothing here reaches into the registers. A `drive`
 * frame is the **Session drive**, Panel-scoped and per tab; it is never the
 * Session lock, and no assertion below reads one for the other.
 */

class FakeCoreLink implements CoreLinkClientLike {
  multiConnection = true;
  /** Every pty this link was asked to start and stop streaming, in order. */
  readonly ptyCalls: Array<{ call: "subscribe" | "unsubscribe"; ptyId: string }> = [];

  onAuthOk() {
    return () => {};
  }
  onAuthError() {
    return () => {};
  }
  onDisconnected() {
    return () => {};
  }
  onProtocolVersion() {
    return () => {};
  }
  onData() {
    return () => {};
  }
  onExit() {
    return () => {};
  }
  onEvent(_cb: (msg: { event: CoreLinkEvent }) => void) {
    return () => {};
  }
  request(frame: CoreLinkRequestFrame): Promise<CoreLinkResponseFrame> {
    return Promise.resolve({
      type: "tasksListResult",
      reqId: (frame as { reqId: string }).reqId,
      tasks: [],
      archivedCount: 0,
    } as CoreLinkResponseFrame);
  }
  ptySubscribe(ptyId: string) {
    this.ptyCalls.push({ call: "subscribe", ptyId });
    return Promise.resolve();
  }
  ptyUnsubscribe(ptyId: string) {
    this.ptyCalls.push({ call: "unsubscribe", ptyId });
    return Promise.resolve();
  }
  canSendMultiConnectionFrames() {
    return this.multiConnection;
  }
  onReclaimed() {
    return () => {};
  }
  close() {}
}

class FakeSource implements CoreLinkSource {
  readonly links = new Map<string, FakeCoreLink>();
  private onClientCb?: (coreId: string, client: CoreLinkClientLike) => void;

  client(coreId: string) {
    return this.links.get(coreId) ?? null;
  }
  onClient(cb: (coreId: string, client: CoreLinkClientLike) => void) {
    this.onClientCb = cb;
    for (const [coreId, link] of this.links) cb(coreId, link);
    return () => {};
  }
  onStatusChange() {
    return () => {};
  }
  statuses(): CoreDialStatus[] {
    return [...this.links.keys()].map((coreId) => ({ coreId, state: "connected", lastSeenAt: 1 }));
  }
  bring(coreId: string): FakeCoreLink {
    const link = new FakeCoreLink();
    this.links.set(coreId, link);
    this.onClientCb?.(coreId, link);
    return link;
  }
}

/** One browser tab's socket, as the router writes to it. */
class FakeTab {
  readonly received: PanelLinkServerFrame[] = [];
  closed = false;

  send(frame: PanelLinkServerFrame) {
    this.received.push(frame);
  }
  close() {
    this.closed = true;
  }

  drives(taskId: string) {
    return this.received.flatMap((f) =>
      f.t === "drive" && f.taskId === taskId ? [{ driving: f.driving, reason: f.reason }] : [],
    );
  }
  lastDrive(taskId: string) {
    return this.drives(taskId).at(-1);
  }
}

const CORE = "core_a";
const TASK = "task_1";

let source: FakeSource;
let router: PanelLinkRouter;

beforeEach(() => {
  source = new FakeSource();
  router = new PanelLinkRouter(source);
});

/** A tab arriving on a fresh socket, presenting the client id it calls itself. */
function openTab(clientId?: string) {
  const tab = new FakeTab();
  const session = router.attach(tab, clientId);
  session.receive({
    t: "core",
    coreId: CORE,
    frame: { type: "subscribe", reqId: "sub", lastEventId: 0 },
  });
  return { tab, session };
}

/** The gesture a pane makes when it mounts on a Session. */
function announce(session: ReturnType<PanelLinkRouter["attach"]>, want: "watch" | "take" | "drop") {
  session.receive({ t: "drive", coreId: CORE, taskId: TASK, want });
}

describe("a tab that reloads onto the Session it alone was driving", () => {
  it("is driving it again on the gesture its new pane makes, not 45 seconds later", () => {
    source.bring(CORE);
    const { session: before } = openTab("tab-a");
    announce(before, "watch");

    // The reload. A new socket, the same tab — and the predecessor is still
    // attached, which is the case the ticket is about.
    const { tab: after, session: reloaded } = openTab("tab-a");
    announce(reloaded, "watch");

    expect(after.lastDrive(TASK)).toEqual({ driving: true, reason: "watch" });
  });

  it("is never told it is following its own ghost", () => {
    source.bring(CORE);
    const { session: before } = openTab("tab-a");
    announce(before, "watch");

    const { tab: after, session: reloaded } = openTab("tab-a");
    announce(reloaded, "watch");

    // Not "it ends up true": it is never false in between. A pane that renders
    // read-only for one frame is the report this ticket opened with.
    expect(after.drives(TASK)).toEqual([{ driving: true, reason: "watch" }]);
  });

  it("keeps the drive when the predecessor's close finally lands", () => {
    source.bring(CORE);
    const { session: before } = openTab("tab-a");
    announce(before, "watch");
    const { tab: after, session: reloaded } = openTab("tab-a");
    announce(reloaded, "watch");

    // The delayed `close` the proxy was sitting on, arriving after the reload.
    before.detach();

    expect(after.lastDrive(TASK)).toEqual({ driving: true, reason: "watch" });
    expect(router.driveFor(CORE, TASK, reloaded)).toBe(true);
  });

  it("drives it just the same when the close lands first, as on loopback", () => {
    source.bring(CORE);
    const { session: before } = openTab("tab-a");
    announce(before, "watch");
    before.detach();

    const { tab: after, session: reloaded } = openTab("tab-a");
    announce(reloaded, "watch");

    expect(after.lastDrive(TASK)).toEqual({ driving: true, reason: "watch" });
  });

  it("retires the ghost socket rather than leaving it to the heartbeat", () => {
    source.bring(CORE);
    const { tab: ghost } = openTab("tab-a");

    openTab("tab-a");

    expect(ghost.closed).toBe(true);
  });

  it("gives the ghost's pty back, because the returning tab asks for its own", () => {
    const link = source.bring(CORE);
    const { session: before } = openTab("tab-a");
    before.receive({
      t: "core",
      coreId: CORE,
      frame: { type: "ptySubscribe", reqId: "p1", ptyId: "pty_1", catchUp: true },
    });
    expect(link.ptyCalls).toEqual([{ call: "subscribe", ptyId: "pty_1" }]);

    const { session: reloaded } = openTab("tab-a");
    reloaded.receive({
      t: "core",
      coreId: CORE,
      frame: { type: "ptySubscribe", reqId: "p2", ptyId: "pty_1", catchUp: true },
    });

    // The ghost's claim went back and the live tab's replaced it. What must not
    // happen is the claim outliving the socket that made it.
    expect(link.ptyCalls).toEqual([
      { call: "subscribe", ptyId: "pty_1" },
      { call: "unsubscribe", ptyId: "pty_1" },
      { call: "subscribe", ptyId: "pty_1" },
    ]);
  });

  it("takes nothing off the tab that reloaded when the ghost's pane is dropped", () => {
    source.bring(CORE);
    const { session: before } = openTab("tab-a");
    announce(before, "watch");
    const { tab: after, session: reloaded } = openTab("tab-a");
    announce(reloaded, "watch");

    // A retired session is detached, so anything still in flight on its socket
    // is ignored — including the `drop` a closing pane would have sent.
    announce(before, "drop");

    expect(router.driveFor(CORE, TASK, reloaded)).toBe(true);
    expect(after.lastDrive(TASK)).toEqual({ driving: true, reason: "watch" });
  });
});

describe("what a client id must not change", () => {
  it("still arbitrates two genuinely different tabs first-come", () => {
    source.bring(CORE);
    const { tab: first, session: firstSession } = openTab("tab-a");
    const { tab: second, session: secondSession } = openTab("tab-b");

    announce(firstSession, "watch");
    announce(secondSession, "watch");

    expect(first.lastDrive(TASK)).toEqual({ driving: true, reason: "watch" });
    expect(second.lastDrive(TASK)).toEqual({ driving: false, reason: "watch" });
  });

  it("still moves the keyboard on the operator's explicit gesture, and says so", () => {
    source.bring(CORE);
    const { tab: first, session: firstSession } = openTab("tab-a");
    const { tab: second, session: secondSession } = openTab("tab-b");
    announce(firstSession, "watch");
    announce(secondSession, "watch");

    announce(secondSession, "take");

    expect(second.lastDrive(TASK)).toEqual({ driving: true, reason: "watch" });
    expect(first.lastDrive(TASK)).toEqual({ driving: false, reason: "handover" });
  });

  it("still hands the drive on when a tab really goes away", () => {
    source.bring(CORE);
    const { session: firstSession } = openTab("tab-a");
    const { tab: second, session: secondSession } = openTab("tab-b");
    announce(firstSession, "watch");
    announce(secondSession, "watch");

    firstSession.detach();

    expect(second.lastDrive(TASK)).toEqual({ driving: true, reason: "watch" });
  });

  it("leaves a tab that presents no id exactly where it was before this ticket", () => {
    source.bring(CORE);
    const { session: before } = openTab();
    announce(before, "watch");

    // No id, so no way to say "this is the same tab" — the second socket is a
    // stranger and queues behind the first, which is the pre-242 behaviour and
    // must stay available rather than becoming an error.
    const { tab: after, session: stranger } = openTab();
    announce(stranger, "watch");

    expect(after.lastDrive(TASK)).toEqual({ driving: false, reason: "watch" });
  });

  it("does not let one tab's id decide anything on another Core", () => {
    source.bring(CORE);
    source.bring("core_b");
    const { session } = openTab("tab-a");
    announce(session, "watch");

    // Same taskId, different Core: a different Session, and a register that
    // mixed them would answer for a machine it was never asked about.
    expect(router.driveFor("core_b", TASK, session)).toBe(false);
  });
});
