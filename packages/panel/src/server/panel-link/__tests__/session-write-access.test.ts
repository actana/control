import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_LOCK_CHANGED_EVENT_KIND } from "@actana/shared/core-link-frames";
import type {
  CoreLinkEvent,
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
} from "@actana/shared/core-link-frames";
import type { CoreDialStatus } from "~/shared/cores";
import type { CoreLinkClientLike } from "../../services/core-link-manager";
import { PanelLinkRouter, type CoreLinkSource } from "../router";
import type { PanelLinkServerFrame } from "~/shared/panel-link";

/**
 * Issue 147's done-when, asserted where a browser could observe it: what the
 * service actually writes to a tab's socket.
 *
 * The router is driven exactly as the two things around it drive it — fake tabs
 * send client frames in, a fake Core link answers and pushes. Nothing here
 * reaches into the registers: if a tab cannot see it on its socket, it does not
 * exist as far as the operator is concerned.
 *
 * The two vocabularies are kept apart on purpose throughout. A `lock` frame is
 * the **Session lock**, Core-scoped, one answer for the whole Panel. A `drive`
 * frame is the **Session drive**, Panel-scoped and per tab. A test that
 * asserted one by reading the other would be the ambiguity this ticket exists
 * to prevent, written down.
 */

class FakeCoreLink implements CoreLinkClientLike {
  answers: (frame: CoreLinkRequestFrame) => CoreLinkResponseFrame = (frame) => ({
    type: "tasksListResult",
    reqId: (frame as { reqId: string }).reqId,
    tasks: [],
    archivedCount: 0,
  });
  readonly sent: CoreLinkRequestFrame[] = [];
  multiConnection = true;
  private event?: (msg: { event: CoreLinkEvent }) => void;
  private reclaimed?: (msg: { replaced: boolean; taskIds: string[] }) => void;
  private ready?: (msg: { version: string | null; compatible: boolean }) => void;
  private disconnected?: (msg: { error?: string }) => void;

  onAuthOk() {
    return () => {};
  }
  onAuthError() {
    return () => {};
  }
  onDisconnected(cb: (msg: { error?: string }) => void) {
    this.disconnected = cb;
    return () => {};
  }
  onProtocolVersion(cb: (msg: { version: string | null; compatible: boolean }) => void) {
    this.ready = cb;
    return () => {};
  }
  onData() {
    return () => {};
  }
  onExit() {
    return () => {};
  }
  onEvent(cb: (msg: { event: CoreLinkEvent }) => void) {
    this.event = cb;
    return () => {};
  }
  request(frame: CoreLinkRequestFrame): Promise<CoreLinkResponseFrame> {
    this.sent.push(frame);
    return Promise.resolve(this.answers(frame));
  }
  ptySubscribe() {
    return Promise.resolve();
  }
  ptyUnsubscribe() {
    return Promise.resolve();
  }
  canSendMultiConnectionFrames() {
    return this.multiConnection;
  }
  onReclaimed(cb: (msg: { replaced: boolean; taskIds: string[] }) => void) {
    this.reclaimed = cb;
    return () => {};
  }
  close() {}

  /** A `session:lockChanged` row on the ordinary event stream (ADR 0024 D8). */
  pushLockChanged(
    taskId: string,
    transition: "claimed" | "released" | "taken-over",
    locked: boolean,
    eventId = 1,
  ) {
    this.event?.({
      event: {
        eventId,
        ts: eventId,
        kind: SESSION_LOCK_CHANGED_EVENT_KIND,
        ptyId: null,
        taskId,
        payload: JSON.stringify({ taskId, transition, locked }),
      },
    });
  }
  pushReclaimed(taskIds: string[]) {
    this.reclaimed?.({ replaced: true, taskIds });
  }
  pushReady() {
    this.ready?.({ version: "1.0.0", compatible: true });
  }
  pushDisconnected() {
    this.disconnected?.({});
  }
}

class FakeTab {
  readonly received: PanelLinkServerFrame[] = [];
  send(frame: PanelLinkServerFrame) {
    this.received.push(frame);
  }
  close() {}

  /** Every Session-lock answer this tab was given, in order. */
  locks(taskId: string) {
    return this.received.flatMap((f) =>
      f.t === "lock" && f.taskId === taskId ? [f.lock] : [],
    );
  }
  /** Every drive answer this tab was given, in order. */
  drives(taskId: string) {
    return this.received.flatMap((f) =>
      f.t === "drive" && f.taskId === taskId ? [{ driving: f.driving, reason: f.reason }] : [],
    );
  }
  lastLock(taskId: string) {
    return this.locks(taskId).at(-1);
  }
  lastDrive(taskId: string) {
    return this.drives(taskId).at(-1);
  }
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
  bring(coreId: string, opts: { multiConnection?: boolean } = {}): FakeCoreLink {
    const link = new FakeCoreLink();
    link.multiConnection = opts.multiConnection !== false;
    this.links.set(coreId, link);
    this.onClientCb?.(coreId, link);
    return link;
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

function openTab() {
  const tab = new FakeTab();
  const session = router.attach(tab);
  session.receive({
    t: "core",
    coreId: CORE,
    frame: { type: "subscribe", reqId: "sub", lastEventId: 0 },
  });
  return { tab, session };
}

/** One task row as a Core publishes it, with its addressed lock (ADR 0024 D8). */
function taskRow(state: "unlocked" | "held-by-you" | "held-by-another") {
  return {
    taskId: TASK,
    projectId: "p1",
    title: "Ship the thing",
    titleManuallySet: false,
    icon: "terminal",
    agent: "claude-code",
    status: "running",
    archived: false,
    pinned: false,
    claudeSessionId: null,
    updatedAt: 1,
    lock: { writable: state !== "held-by-another", state },
  };
}

function listTasks(session: ReturnType<PanelLinkRouter["attach"]>, link: FakeCoreLink, row: unknown) {
  link.answers = (frame) => ({
    type: "tasksListResult",
    reqId: (frame as { reqId: string }).reqId,
    tasks: [row] as never,
    archivedCount: 0,
  });
  return session.receive({
    t: "core",
    coreId: CORE,
    frame: { type: "tasksList", reqId: "q1" },
  });
}

describe("a Session another Core client holds", () => {
  it("is published to every watching tab as read-only, without anybody typing", async () => {
    const link = source.bring(CORE);
    const { tab, session } = openTab();

    await listTasks(session, link, taskRow("held-by-another"));

    // The snapshot alone did it. No keystroke, no refused write, no second
    // round trip — which is the whole of what D8 is for.
    expect(tab.lastLock(TASK)).toEqual({
      supported: true,
      writable: false,
      state: "held-by-another",
    });
  });

  it("tells a tab that opens later, on the gesture that announces its pane", async () => {
    const link = source.bring(CORE);
    const { session: first } = openTab();
    await listTasks(first, link, taskRow("held-by-another"));

    // A second tab was not watching when the register learned it. It asks by
    // opening a pane, and is answered before it can render an editable one.
    const { tab: second, session } = openTab();
    session.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });

    expect(second.lastLock(TASK)).toEqual({
      supported: true,
      writable: false,
      state: "held-by-another",
    });
  });
});

describe("claiming a Session from the Panel", () => {
  it("reflects in the UI on the answer, with no refetch", async () => {
    const link = source.bring(CORE);
    const { tab, session } = openTab();
    await listTasks(session, link, taskRow("unlocked"));
    expect(tab.lastLock(TASK)?.state).toBe("unlocked");

    link.answers = (frame) => ({
      type: "claimResult",
      reqId: (frame as { reqId: string }).reqId,
      taskId: TASK,
      granted: true,
    });
    await session.receive({
      t: "core",
      coreId: CORE,
      frame: { type: "claim", reqId: "c1", taskId: TASK },
    });

    expect(tab.lastLock(TASK)).toEqual({ supported: true, writable: true, state: "held-by-you" });
    // Nothing was re-listed to find that out.
    expect(link.sent.filter((f) => f.type === "tasksList")).toHaveLength(1);
  });

  it("reaches the Panel's other tabs too — one connection holds it for all of them", async () => {
    const link = source.bring(CORE);
    const { session: driver } = openTab();
    const { tab: other, session: otherSession } = openTab();
    otherSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });

    link.answers = (frame) => ({
      type: "claimResult",
      reqId: (frame as { reqId: string }).reqId,
      taskId: TASK,
      granted: true,
    });
    await driver.receive({
      t: "core",
      coreId: CORE,
      frame: { type: "claim", reqId: "c1", taskId: TASK },
    });

    expect(other.lastLock(TASK)?.state).toBe("held-by-you");
  });

  it("queues no echo for a re-claim the Core publishes nothing for", async () => {
    // Two tabs both reading `unlocked` and both clicking Claim: the second
    // claim is granted and idempotent, and the Core appends no event for it
    // ("nothing changed publishes nothing"). An echo queued here would have no
    // event to match, would outlive its gesture, and would swallow the next
    // real lock change from another client — the loser's notice D8 exists for.
    const link = source.bring(CORE);
    const { tab, session } = openTab();
    await listTasks(session, link, taskRow("unlocked"));
    link.answers = (frame) => ({
      type: "claimResult",
      reqId: (frame as { reqId: string }).reqId,
      taskId: TASK,
      granted: true,
    });

    await session.receive({
      t: "core",
      coreId: CORE,
      frame: { type: "claim", reqId: "c1", taskId: TASK },
    });
    link.pushLockChanged(TASK, "claimed", true, 1); // the first claim's echo
    await session.receive({
      t: "core",
      coreId: CORE,
      frame: { type: "claim", reqId: "c2", taskId: TASK },
    });
    expect(tab.lastLock(TASK)?.state).toBe("held-by-you");

    // The Panel gives it back, and its `released` echo must be the one that is
    // consumed — not left mismatched behind a stale `claimed`.
    link.answers = (frame) => ({
      type: "releaseResult",
      reqId: (frame as { reqId: string }).reqId,
      taskId: TASK,
      released: true,
    });
    await session.receive({
      t: "core",
      coreId: CORE,
      frame: { type: "release", reqId: "r1", taskId: TASK },
    });
    link.pushLockChanged(TASK, "released", false, 2);
    expect(tab.lastLock(TASK)?.state).toBe("unlocked");

    // Another Core client takes the free Session. This is somebody else's
    // change and the tab has to see it, or it keeps an editable terminal on a
    // Session this Panel does not hold until something refetches.
    link.pushLockChanged(TASK, "claimed", true, 3);

    expect(tab.lastLock(TASK)).toEqual({
      supported: true,
      writable: false,
      state: "held-by-another",
    });
  });

  it("does not report a claim another client denied as a hold", async () => {
    const link = source.bring(CORE);
    const { tab, session } = openTab();
    link.answers = (frame) => ({
      type: "claimResult",
      reqId: (frame as { reqId: string }).reqId,
      taskId: TASK,
      granted: false,
    });

    await session.receive({
      t: "core",
      coreId: CORE,
      frame: { type: "claim", reqId: "c1", taskId: TASK },
    });

    expect(tab.lastLock(TASK)).toEqual({
      supported: true,
      writable: false,
      state: "held-by-another",
    });
  });
});

describe("a force takeover", () => {
  it("leaves this Panel holding the Session, and its own echo does not undo that", async () => {
    const link = source.bring(CORE);
    const { tab, session } = openTab();
    await listTasks(session, link, taskRow("held-by-another"));

    link.answers = (frame) => ({
      type: "forceTakeoverResult",
      reqId: (frame as { reqId: string }).reqId,
      taskId: TASK,
      takenFrom: "another-connection",
    });
    await session.receive({
      t: "core",
      coreId: CORE,
      frame: { type: "forceTakeover", reqId: "f1", taskId: TASK },
    });
    expect(tab.lastLock(TASK)?.state).toBe("held-by-you");

    // The Core's own event for the takeover this Panel performed arrives after
    // the answer, because live events are polled. Read naively it says "the
    // holder is now somebody" — and the tab that just took the Session would be
    // told it lost it.
    link.pushLockChanged(TASK, "taken-over", true);
    expect(tab.lastLock(TASK)?.state).toBe("held-by-you");
  });

  it("is how the loser finds out — on the event, before its next keystroke", async () => {
    const link = source.bring(CORE);
    const { tab, session } = openTab();
    link.answers = (frame) => ({
      type: "claimResult",
      reqId: (frame as { reqId: string }).reqId,
      taskId: TASK,
      granted: true,
    });
    await session.receive({
      t: "core",
      coreId: CORE,
      frame: { type: "claim", reqId: "c1", taskId: TASK },
    });
    // Our own claim's echo, consumed.
    link.pushLockChanged(TASK, "claimed", true, 1);
    expect(tab.lastLock(TASK)?.state).toBe("held-by-you");

    // Somebody else takes it. Nothing was sent, nothing was refused, and this
    // Panel learns it is a Reader now.
    link.pushLockChanged(TASK, "taken-over", true, 2);

    expect(tab.lastLock(TASK)).toEqual({
      supported: true,
      writable: false,
      state: "held-by-another",
    });
  });

  it("frees the Session for everybody when the holder releases it", async () => {
    const link = source.bring(CORE);
    const { tab, session } = openTab();
    await listTasks(session, link, taskRow("held-by-another"));

    link.pushLockChanged(TASK, "released", false);

    expect(tab.lastLock(TASK)).toEqual({ supported: true, writable: true, state: "unlocked" });
  });
});

describe("two tabs of one Panel on one Session", () => {
  it("gives the keyboard to the first and makes the second a follower", () => {
    source.bring(CORE);
    const { tab: first, session: firstSession } = openTab();
    const { tab: second, session: secondSession } = openTab();

    firstSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });
    secondSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });

    expect(first.lastDrive(TASK)?.driving).toBe(true);
    expect(second.lastDrive(TASK)?.driving).toBe(false);
    // And it is obvious which: both were told, neither had to infer it from the
    // other's silence.
    expect(first.drives(TASK)).toHaveLength(1);
    expect(second.drives(TASK)).toHaveLength(1);
  });

  it("hands the keyboard over on request, and tells the loser it was a handover", () => {
    source.bring(CORE);
    const { tab: first, session: firstSession } = openTab();
    const { tab: second, session: secondSession } = openTab();
    firstSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });
    secondSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });

    secondSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "take" });

    expect(second.lastDrive(TASK)).toEqual({ driving: true, reason: "watch" });
    // The loser's own event, with its own reason. Not a takeover: nothing left
    // this Panel and no Core heard about it.
    expect(first.lastDrive(TASK)).toEqual({ driving: false, reason: "handover" });
  });

  it("never mentions the Session lock while arbitrating tabs", () => {
    source.bring(CORE);
    const { tab: first, session: firstSession } = openTab();
    const { session: secondSession } = openTab();
    firstSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });
    secondSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });
    const before = first.locks(TASK).length;

    secondSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "take" });

    // A handover is not a lock change. The Panel still holds exactly what it
    // held, and nothing went down the core-link (ADR 0024 D3).
    expect(first.locks(TASK)).toHaveLength(before);
    expect(source.links.get(CORE)!.sent).toHaveLength(0);
  });

  it("passes the keyboard on when the driving tab goes away", () => {
    source.bring(CORE);
    const { session: firstSession } = openTab();
    const { tab: second, session: secondSession } = openTab();
    firstSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });
    secondSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });

    firstSession.detach();

    // Told it drives now — and told it plainly, not as a handover it performed.
    expect(second.lastDrive(TASK)).toEqual({ driving: true, reason: "watch" });
  });
});

describe("a reconnect", () => {
  it("re-learns the Sessions the reclaim brought across (ADR 0024 D9)", async () => {
    const link = source.bring(CORE);
    const { tab, session } = openTab();
    await listTasks(session, link, taskRow("held-by-you"));

    // The link dropped: every lock it held went with it.
    link.pushDisconnected();
    expect(tab.lastLock(TASK)?.state).toBe("unlocked");

    // A new connection presents the same client id, and the Core moves the
    // locks across. No event says so — the transfer is a rewrite in place — so
    // `reclaimResult.taskIds` is the only thing that can tell the Panel.
    link.pushReady();
    link.pushReclaimed([TASK]);

    expect(tab.lastLock(TASK)).toEqual({ supported: true, writable: true, state: "held-by-you" });
  });
});

describe("a Core without the multiConnection capability", () => {
  it("publishes no lock at all — the Panel behaves exactly as it does today", async () => {
    const link = source.bring(CORE, { multiConnection: false });
    const { tab, session } = openTab();

    // Even a Core that somehow published lock state is not believed: this Core
    // has no lock table, and a Panel that rendered one would show a Session
    // locked against the only client that Core has.
    await listTasks(session, link, taskRow("held-by-another"));

    for (const lock of tab.locks(TASK)) {
      expect(lock.supported).toBe(false);
      expect(lock.writable).toBe(true);
    }
  });

  it("arbitrates nothing between tabs — both of them drive, as they do today", () => {
    source.bring(CORE, { multiConnection: false });
    const { tab: first, session: firstSession } = openTab();
    const { tab: second, session: secondSession } = openTab();

    firstSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });
    secondSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });

    expect(first.lastDrive(TASK)?.driving).toBe(true);
    expect(second.lastDrive(TASK)?.driving).toBe(true);
    expect(first.lastLock(TASK)).toEqual({
      supported: false,
      writable: true,
      state: "unlocked",
    });
  });

  it("takes nothing off a tab when another one asks to drive", () => {
    source.bring(CORE, { multiConnection: false });
    const { tab: first, session: firstSession } = openTab();
    const { session: secondSession } = openTab();
    firstSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "watch" });

    secondSession.receive({ t: "drive", coreId: CORE, taskId: TASK, want: "take" });

    // Nothing arbitrated it, so nothing was lost. The first tab was told once,
    // that it drives, and never told otherwise.
    expect(first.drives(TASK)).toEqual([{ driving: true, reason: "watch" }]);
  });
});
