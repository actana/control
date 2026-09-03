// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setPanelBridgeForTests, type PanelBridge } from "../panel-bridge";
import {
  __resetSessionWriteStoreForTests,
  onSessionDriveHandover,
  readSessionWriteState,
  releaseSessionDrive,
  takeSessionDrive,
  watchSessionDrive,
} from "../session-write-store";
import {
  OPTIMISTIC_DRIVE_WINDOW_MS,
  type SessionWriteAccess,
} from "~/shared/session-write-access";

// The browser's copy of "may I type into this Session". Both facts are pushed —
// nothing here polls and nothing refetches — so what is asserted is what a pane
// would read the instant a frame lands.

type Handlers = {
  lock?: (msg: Parameters<Parameters<PanelBridge["onSessionLock"]>[0]>[0]) => void;
  drive?: (msg: Parameters<Parameters<PanelBridge["onSessionDrive"]>[0]>[0]) => void;
};

function fakeBridge() {
  const handlers: Handlers = {};
  const drives: Array<{ taskId: string; take: boolean }> = [];
  // The pane count the real link client keeps, and the answer the store asks it
  // for (issue 186). A fake that said "last pane" to every release would pass a
  // test the product fails, so this one counts.
  const panes = new Map<string, number>();
  const bridge = {
    onSessionLock: (cb: NonNullable<Handlers["lock"]>) => {
      handlers.lock = cb;
      return () => {};
    },
    onSessionDrive: (cb: NonNullable<Handlers["drive"]>) => {
      handlers.drive = cb;
      return () => {};
    },
    driveSession: (_coreId: string, taskId: string, opts?: { take?: boolean }) => {
      drives.push({ taskId, take: opts?.take === true });
      if (opts?.take !== true) panes.set(taskId, (panes.get(taskId) ?? 0) + 1);
    },
    releaseSessionDrive: (_coreId: string, taskId: string) => {
      drives.push({ taskId, take: false });
      const open = panes.get(taskId) ?? 0;
      if (open > 1) {
        panes.set(taskId, open - 1);
        return false;
      }
      panes.delete(taskId);
      return true;
    },
  } as unknown as PanelBridge;
  __setPanelBridgeForTests(bridge);
  // The store wires itself on first use rather than at import, so that it never
  // reaches for a link while server-rendering. One read is what arms it.
  readSessionWriteState("", "");
  return { handlers, drives };
}

afterEach(() => {
  __resetSessionWriteStoreForTests();
  __setPanelBridgeForTests(null);
  vi.useRealTimers();
});

const CORE = "core_a";
const TASK = "task_1";

describe("the browser's session write state", () => {
  it("opens writable on a Session it has heard nothing about", () => {
    fakeBridge();
    // The same optimism the Core has: an unlocked Session is writable by
    // anybody, and a pane that opened read-only waiting for permission would
    // render every Session on a single-connection Core as locked forever.
    expect(readSessionWriteState(CORE, TASK).access).toEqual({ writable: true });
  });

  it("goes read-only the moment the lock says another client holds it", () => {
    const { handlers } = fakeBridge();
    readSessionWriteState(CORE, TASK);

    handlers.lock?.({
      coreId: CORE,
      taskId: TASK,
      lock: { supported: true, writable: false, state: "held-by-another" },
    });

    expect(readSessionWriteState(CORE, TASK).access).toEqual({
      writable: false,
      reason: "held-by-another-client",
    });
  });

  it("goes read-only for the other reason when another tab takes the keyboard", () => {
    const { handlers } = fakeBridge();
    readSessionWriteState(CORE, TASK);
    handlers.drive?.({ coreId: CORE, taskId: TASK, driving: true, reason: "watch" });
    expect(readSessionWriteState(CORE, TASK).access).toEqual({ writable: true });

    handlers.drive?.({ coreId: CORE, taskId: TASK, driving: false, reason: "handover" });

    expect(readSessionWriteState(CORE, TASK).access).toEqual({
      writable: false,
      reason: "driven-in-another-tab",
    });
  });

  it("keeps the two facts apart — a drive answer does not overwrite the lock", () => {
    const { handlers } = fakeBridge();
    readSessionWriteState(CORE, TASK);
    handlers.lock?.({
      coreId: CORE,
      taskId: TASK,
      lock: { supported: true, writable: true, state: "held-by-you" },
    });

    handlers.drive?.({ coreId: CORE, taskId: TASK, driving: false, reason: "handover" });

    const state = readSessionWriteState(CORE, TASK);
    expect(state.lock.state).toBe("held-by-you");
    expect(state.drive).toBe("following");
  });

  it("announces a handover, and only for the intra-Panel one", () => {
    const { handlers } = fakeBridge();
    const seen = vi.fn();
    onSessionDriveHandover(seen);

    // A pane simply being told where it stands is not an event worth a sentence.
    handlers.drive?.({ coreId: CORE, taskId: TASK, driving: false, reason: "watch" });
    expect(seen).not.toHaveBeenCalled();

    handlers.drive?.({ coreId: CORE, taskId: TASK, driving: false, reason: "handover" });
    expect(seen).toHaveBeenCalledWith({ coreId: CORE, taskId: TASK });

    // Losing the lock to another Core client is a different event and must not
    // arrive on this channel — the two have different copy.
    handlers.lock?.({
      coreId: CORE,
      taskId: TASK,
      lock: { supported: true, writable: false, state: "held-by-another" },
    });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("keeps two Cores' Sessions apart even when their task ids collide", () => {
    const { handlers } = fakeBridge();
    handlers.lock?.({
      coreId: "core_a",
      taskId: TASK,
      lock: { supported: true, writable: false, state: "held-by-another" },
    });

    expect(readSessionWriteState("core_a", TASK).access.writable).toBe(false);
    expect(readSessionWriteState("core_b", TASK).access.writable).toBe(true);
  });
});

describe("the drive gestures", () => {
  it("announces a pane without asking for the keyboard, and asks when told to", () => {
    const { drives } = fakeBridge();

    watchSessionDrive(CORE, TASK);
    takeSessionDrive(CORE, TASK);

    // First-come on mount; the explicit gesture is the only thing that moves a
    // keyboard off another tab of this Panel.
    expect(drives).toEqual([
      { taskId: TASK, take: false },
      { taskId: TASK, take: true },
    ]);
  });

  it("keeps the tab's answer while a second pane on the Session is still open", () => {
    const { handlers } = fakeBridge();

    // Two panes in this tab, one Session — a split view, or the same Session
    // opened twice. The drive is the *tab's*, so both panes read one answer.
    watchSessionDrive(CORE, TASK);
    watchSessionDrive(CORE, TASK);
    handlers.drive?.({ coreId: CORE, taskId: TASK, driving: true, reason: "watch" });

    releaseSessionDrive(CORE, TASK);

    // The tab still has the Session on screen and the service still has it
    // driving. Reading `none` here is what let the surviving pane keep a
    // writable surface after the drive had gone somewhere else — issue 186's
    // silent dual write, seen from the browser.
    expect(readSessionWriteState(CORE, TASK).drive).toBe("driving");
    expect(readSessionWriteState(CORE, TASK).access.writable).toBe(true);
  });

  it("clears the tab's answer when the last pane on the Session closes", () => {
    const { handlers } = fakeBridge();

    watchSessionDrive(CORE, TASK);
    watchSessionDrive(CORE, TASK);
    handlers.drive?.({ coreId: CORE, taskId: TASK, driving: true, reason: "watch" });
    releaseSessionDrive(CORE, TASK);
    releaseSessionDrive(CORE, TASK);

    expect(readSessionWriteState(CORE, TASK).drive).toBe("none");
  });

  it("does nothing for a pane with no Core to address", () => {
    const { drives } = fakeBridge();
    watchSessionDrive(null, TASK);
    releaseSessionDrive(null, TASK);
    expect(drives).toEqual([]);
  });
});

// ─── Issue 393: the unanswered drive ────────────────────────────────────────
//
// `none` used to mean two things at once — "this tab has not asked" and "this
// tab asked and is waiting" — and both read as writable, with nothing on screen
// to say which. So two tabs opened on one Session both typed into it, for as
// long as the answer took and with no upper bound on that at all. The states
// are now spelt apart, and the waiting one is writable only inside a window
// that closes.

/**
 * The Panel service's drive arbitration, reduced to what a tab can observe:
 * first-come, and `take` moves it (see `wantDrive` in the panel-link router).
 *
 * Shared between the fake bridges below so the two-tab suite is answered by one
 * arbiter rather than by hand — a test that fed each tab the answer it wanted
 * would prove nothing about two tabs.
 */
function driveArbiter() {
  const drivers = new Map<string, string>();
  return {
    want(taskId: string, tabId: string, take: boolean): boolean {
      if (take || !drivers.has(taskId)) drivers.set(taskId, tabId);
      return drivers.get(taskId) === tabId;
    },
  };
}

/**
 * A bridge whose answers are queued rather than instant, because the window is
 * only observable in the gap. {@link flush} is the service getting round to it.
 */
function deferredBridge(opts: { arbiter?: ReturnType<typeof driveArbiter>; tabId?: string } = {}) {
  const arbiter = opts.arbiter ?? driveArbiter();
  const tabId = opts.tabId ?? "tab_1";
  const handlers: Handlers = {};
  const queued: Array<() => void> = [];
  const bridge = {
    onSessionLock: (cb: NonNullable<Handlers["lock"]>) => {
      handlers.lock = cb;
      return () => {};
    },
    onSessionDrive: (cb: NonNullable<Handlers["drive"]>) => {
      handlers.drive = cb;
      return () => {};
    },
    driveSession: (coreId: string, taskId: string, o?: { take?: boolean }) => {
      const driving = arbiter.want(taskId, tabId, o?.take === true);
      queued.push(() => handlers.drive?.({ coreId, taskId, driving, reason: "watch" }));
    },
    releaseSessionDrive: () => true,
  } as unknown as PanelBridge;
  __setPanelBridgeForTests(bridge);
  readSessionWriteState("", "");
  return { handlers, flush: () => queued.splice(0).forEach((send) => send()) };
}

describe("the optimistic window on an unanswered drive", () => {
  it("lets the pane type while it waits, and marks the write as a guess", () => {
    vi.useFakeTimers();
    deferredBridge();

    watchSessionDrive(CORE, TASK);

    const state = readSessionWriteState(CORE, TASK);
    // Writable, because a solo tab that opened read-only and waited would be a
    // pane the operator cannot type into for no reason at all — and `pending`
    // rather than `none`, because this tab *has* asked. The two are different
    // facts and the difference is what bounds the guess.
    expect(state.access).toEqual({ writable: true });
    expect(state.drive).toBe("pending");
    // The visible half: the pane renders a notice off this the whole time.
    expect(state.optimistic).toBe(true);
  });

  it("stops typing on the guess when the window closes unanswered", () => {
    vi.useFakeTimers();
    deferredBridge();
    watchSessionDrive(CORE, TASK);

    vi.advanceTimersByTime(OPTIMISTIC_DRIVE_WINDOW_MS);

    const state = readSessionWriteState(CORE, TASK);
    // The bound. Before it, an answer that never came left the pane writable
    // forever, next to another tab in exactly the same state.
    expect(state.access).toEqual({ writable: false, reason: "awaiting-drive" });
    expect(state.optimistic).toBe(false);
    expect(state.drive).toBe("pending");
  });

  it("is short — the pane is still writable a beat before the window closes", () => {
    vi.useFakeTimers();
    deferredBridge();
    watchSessionDrive(CORE, TASK);

    vi.advanceTimersByTime(OPTIMISTIC_DRIVE_WINDOW_MS - 1);
    expect(readSessionWriteState(CORE, TASK).access).toEqual({ writable: true });
    // A round trip to the Panel's own service, not to a Core: a window this
    // long is one no pane on a healthy link ever reaches the end of.
    expect(OPTIMISTIC_DRIVE_WINDOW_MS).toBeLessThanOrEqual(2_000);
  });

  it("settles on the answer and stops guessing", () => {
    vi.useFakeTimers();
    const { flush } = deferredBridge();
    watchSessionDrive(CORE, TASK);

    flush();

    expect(readSessionWriteState(CORE, TASK).drive).toBe("driving");
    expect(readSessionWriteState(CORE, TASK).optimistic).toBe(false);
    // And the window it opened does not fire over the settled answer later.
    vi.advanceTimersByTime(OPTIMISTIC_DRIVE_WINDOW_MS * 4);
    expect(readSessionWriteState(CORE, TASK).access).toEqual({ writable: true });
  });

  it("believes an answer that arrives after the window closed", () => {
    vi.useFakeTimers();
    const { flush } = deferredBridge();
    watchSessionDrive(CORE, TASK);
    vi.advanceTimersByTime(OPTIMISTIC_DRIVE_WINDOW_MS);
    expect(readSessionWriteState(CORE, TASK).access.writable).toBe(false);

    flush();

    // Closing the window withdraws a guess; it does not decide the question.
    expect(readSessionWriteState(CORE, TASK).access).toEqual({ writable: true });
    expect(readSessionWriteState(CORE, TASK).drive).toBe("driving");
  });

  it("does not reopen a window for a second pane of a tab that already asked", () => {
    vi.useFakeTimers();
    const { flush } = deferredBridge();
    watchSessionDrive(CORE, TASK);
    flush();

    // A split view, or the same Session opened twice in one tab. The link
    // client announces only the first pane, so there is nothing to wait for.
    watchSessionDrive(CORE, TASK);

    expect(readSessionWriteState(CORE, TASK).drive).toBe("driving");
    expect(readSessionWriteState(CORE, TASK).optimistic).toBe(false);
  });

  it("does not hand the keyboard to a tab on its own say-so when it asks for it", () => {
    vi.useFakeTimers();
    const arbiter = driveArbiter();
    const first = deferredBridge({ arbiter, tabId: "tab_1" });
    watchSessionDrive(CORE, TASK);
    first.flush();
    // Now the second tab, against the same arbiter: it is following, because
    // the first one asked first.
    __resetSessionWriteStoreForTests();
    const second = deferredBridge({ arbiter, tabId: "tab_2" });
    watchSessionDrive(CORE, TASK);
    second.flush();
    expect(readSessionWriteState(CORE, TASK).access).toEqual({
      writable: false,
      reason: "driven-in-another-tab",
    });

    takeSessionDrive(CORE, TASK);

    // The gesture is sent, and the pane waits: the tab it is taking from still
    // believes it is driving until the service says otherwise, and typing here
    // in the meantime is the dual write the whole store exists to prevent.
    const state = readSessionWriteState(CORE, TASK);
    expect(state.drive).toBe("pending");
    expect(state.access).toEqual({ writable: false, reason: "awaiting-drive" });

    second.flush();
    expect(readSessionWriteState(CORE, TASK).access).toEqual({ writable: true });
  });

  it("stops waiting when the last pane on the Session closes", () => {
    vi.useFakeTimers();
    deferredBridge();
    watchSessionDrive(CORE, TASK);

    releaseSessionDrive(CORE, TASK);

    // Back to "nobody asked", and no window left running over it.
    expect(readSessionWriteState(CORE, TASK).drive).toBe("none");
    vi.advanceTimersByTime(OPTIMISTIC_DRIVE_WINDOW_MS * 2);
    expect(readSessionWriteState(CORE, TASK).drive).toBe("none");
  });

  it("keeps the guess across a lock answer, which says nothing about the drive", () => {
    vi.useFakeTimers();
    const { handlers } = deferredBridge();
    watchSessionDrive(CORE, TASK);

    handlers.lock?.({
      coreId: CORE,
      taskId: TASK,
      lock: { supported: true, writable: true, state: "unlocked" },
    });

    expect(readSessionWriteState(CORE, TASK).optimistic).toBe(true);
    // …and the lock still wins when it says no. A pane that may not write at
    // all is told about the client holding the Session, not about a drive.
    handlers.lock?.({
      coreId: CORE,
      taskId: TASK,
      lock: { supported: true, writable: false, state: "held-by-another" },
    });
    expect(readSessionWriteState(CORE, TASK).access).toEqual({
      writable: false,
      reason: "held-by-another-client",
    });
  });
});

describe("two tabs on one Session", () => {
  /**
   * One tab's whole life against a shared arbiter, reduced to what it reads.
   *
   * The store is a module singleton — one per tab in a browser, and one per
   * test here — so the tabs are run in turn and their answers collected. What
   * is asserted is the pair, which is the thing issue 393 is about.
   */
  function tabAsks(
    arbiter: ReturnType<typeof driveArbiter>,
    tabId: string,
    opts: { answer: boolean },
  ): { duringWindow: SessionWriteAccess; settled: SessionWriteAccess } {
    __resetSessionWriteStoreForTests();
    const { flush } = deferredBridge({ arbiter, tabId });
    watchSessionDrive(CORE, TASK);
    const duringWindow = readSessionWriteState(CORE, TASK).access;
    if (opts.answer) flush();
    else vi.advanceTimersByTime(OPTIMISTIC_DRIVE_WINDOW_MS);
    return { duringWindow, settled: readSessionWriteState(CORE, TASK).access };
  }

  it("leaves at most one of them writable once the drive is known", () => {
    vi.useFakeTimers();
    const arbiter = driveArbiter();

    const first = tabAsks(arbiter, "tab_1", { answer: true });
    const second = tabAsks(arbiter, "tab_2", { answer: true });

    // The acceptance criterion, stated as the arithmetic it is.
    const writable = [first.settled, second.settled].filter((a) => a.writable);
    expect(writable).toHaveLength(1);
    expect(first.settled).toEqual({ writable: true });
    expect(second.settled).toEqual({ writable: false, reason: "driven-in-another-tab" });
  });

  it("leaves at most one of them writable when the answers never come", () => {
    vi.useFakeTimers();
    const arbiter = driveArbiter();

    // The case that used to be unbounded: nothing answers either tab. Both
    // typed, forever. Now both windows close and neither does.
    const first = tabAsks(arbiter, "tab_1", { answer: false });
    const second = tabAsks(arbiter, "tab_2", { answer: false });

    expect([first.settled, second.settled].filter((a) => a.writable)).toHaveLength(0);
    expect(first.settled).toEqual({ writable: false, reason: "awaiting-drive" });
    expect(second.settled).toEqual({ writable: false, reason: "awaiting-drive" });
  });

  it("bounds the window in which both of them can type", () => {
    vi.useFakeTimers();
    const arbiter = driveArbiter();

    const first = tabAsks(arbiter, "tab_1", { answer: false });
    const second = tabAsks(arbiter, "tab_2", { answer: false });

    // Both tabs are writable inside their window — that is the optimism, and
    // it is kept on purpose. What issue 393 asks of it is that it end, and be
    // on screen while it lasts, not that it never happen.
    expect(first.duringWindow).toEqual({ writable: true });
    expect(second.duringWindow).toEqual({ writable: true });
    expect(OPTIMISTIC_DRIVE_WINDOW_MS).toBeGreaterThan(0);
  });
});
