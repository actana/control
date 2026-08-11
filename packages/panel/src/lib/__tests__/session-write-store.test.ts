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
    },
    releaseSessionDrive: (_coreId: string, taskId: string) => {
      drives.push({ taskId, take: false });
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

  it("does nothing for a pane with no Core to address", () => {
    const { drives } = fakeBridge();
    watchSessionDrive(null, TASK);
    releaseSessionDrive(null, TASK);
    expect(drives).toEqual([]);
  });
});
