import { describe, expect, it, vi } from "vitest";
import { corePtyBridgeFor } from "../core-pty-bridge";
import type { PanelLinkClient } from "../panel-link-client";

/**
 * The PTY transport as a terminal pane sees it: calls go down the link tagged
 * with a Core, and only that Core's output comes back up.
 */

type Sent = { coreId: string; frame: Record<string, unknown> };

function fakeLink() {
  const sent: Sent[] = [];
  const dataListeners: Array<(m: unknown) => void> = [];
  const exitListeners: Array<(m: unknown) => void> = [];
  const connectionListeners: Array<(connected: boolean) => void> = [];
  const watched: string[] = [];
  let answer: Record<string, unknown> = { type: "ok" };

  const request = async (coreId: string, frame: Record<string, unknown>) => {
    sent.push({ coreId, frame });
    return answer;
  };

  const link = {
    watch: (coreId: string) => {
      watched.push(coreId);
      return () => {};
    },
    request,
    // The real client remembers the claim as well as sending it, so that a
    // reconnect can re-ask; what the bridge is on the hook for is the frame and
    // the Core it is addressed to. See `panel-link-client.test.ts` for the set.
    ptySubscribe: async (coreId: string, ptyId: string, opts?: { catchUp?: boolean }) => {
      await request(coreId, { type: "ptySubscribe", ptyId, catchUp: opts?.catchUp === true });
    },
    ptyUnsubscribe: async (coreId: string, ptyId: string) => {
      await request(coreId, { type: "ptyUnsubscribe", ptyId });
    },
    onPtyData: (cb: (m: unknown) => void) => {
      dataListeners.push(cb);
      return () => {};
    },
    onPtyExit: (cb: (m: unknown) => void) => {
      exitListeners.push(cb);
      return () => {};
    },
    onConnectionChange: (cb: (connected: boolean) => void) => {
      connectionListeners.push(cb);
      return () => {};
    },
  } as unknown as PanelLinkClient;

  return {
    link,
    sent,
    watched,
    answers: (frame: Record<string, unknown>) => {
      answer = frame;
    },
    pushData: (msg: unknown) => dataListeners.forEach((cb) => cb(msg)),
    pushExit: (msg: unknown) => exitListeners.forEach((cb) => cb(msg)),
    setConnected: (connected: boolean) => connectionListeners.forEach((cb) => cb(connected)),
  };
}

describe("corePtyBridgeFor", () => {
  it("is the same object for a Core, so its panes share one subscription", () => {
    const { link } = fakeLink();
    expect(corePtyBridgeFor(link, "core_a")).toBe(corePtyBridgeFor(link, "core_a"));
    expect(corePtyBridgeFor(link, "core_a")).not.toBe(corePtyBridgeFor(link, "core_b"));
  });

  it("watches the Core it is created for, so its PTY pushes reach this tab", () => {
    const fake = fakeLink();
    corePtyBridgeFor(fake.link, "core_watch");
    expect(fake.watched).toEqual(["core_watch"]);
  });

  it("addresses spawn to its Core and answers with the new ptyId", async () => {
    const fake = fakeLink();
    fake.answers({ type: "spawned", ptyId: "pty-9" });
    const bridge = corePtyBridgeFor(fake.link, "core_spawn");
    await expect(
      bridge.spawn({ taskId: "t1", cwd: "/srv/app", command: "claude", agent: "claude-code" }),
      // A Core that predates issue 84 answers without
      // `hooksReportTurnStart`; the bridge reads that as "no", which keeps the
      // Panel's terminal-input fallback armed rather than suppressed on a
      // promise nobody made.
    ).resolves.toEqual({ ptyId: "pty-9", hooksReportTurnStart: false });
    expect(fake.sent[0]).toEqual({
      coreId: "core_spawn",
      frame: { type: "spawn", opts: expect.objectContaining({ taskId: "t1" }) },
    });
  });

  it("sends keystrokes, resizes and kills to its Core", async () => {
    const fake = fakeLink();
    fake.answers({ type: "writeResult", ok: true });
    const bridge = corePtyBridgeFor(fake.link, "core_io");
    await expect(bridge.write("pty-1", "ls\r")).resolves.toBe(true);
    await bridge.resize("pty-1", 120, 40);
    await bridge.kill("pty-1");
    expect(fake.sent.map((s) => s.frame)).toEqual([
      { type: "write", ptyId: "pty-1", data: "ls\r" },
      { type: "resize", ptyId: "pty-1", cols: 120, rows: 40 },
      { type: "kill", ptyId: "pty-1" },
    ]);
    expect(fake.sent.every((s) => s.coreId === "core_io")).toBe(true);
  });

  it("carries a reattach cursor into replay and hands back where the tail starts", async () => {
    const fake = fakeLink();
    fake.answers({ type: "replayResult", data: "tail", nextSeq: 12, from: 10 });
    const bridge = corePtyBridgeFor(fake.link, "core_replay");
    await expect(bridge.replay("pty-1", 10)).resolves.toEqual({
      data: "tail",
      nextSeq: 12,
      from: 10,
    });
    expect(fake.sent[0]!.frame).toEqual({ type: "replay", ptyId: "pty-1", sinceSeq: 10 });
  });

  it("delivers only its own Core's output and exits", () => {
    const fake = fakeLink();
    const bridge = corePtyBridgeFor(fake.link, "core_mine");
    const data = vi.fn();
    const exit = vi.fn();
    bridge.onData(data);
    bridge.onExit(exit);

    fake.pushData({ coreId: "core_theirs", ptyId: "p1", data: "not mine", seq: 1 });
    fake.pushData({ coreId: "core_mine", ptyId: "p1", data: "mine", seq: 2 });
    fake.pushExit({ coreId: "core_theirs", ptyId: "p1", exitCode: 1 });
    fake.pushExit({ coreId: "core_mine", ptyId: "p1", exitCode: 0 });

    expect(data.mock.calls).toEqual([[{ ptyId: "p1", data: "mine", seq: 2 }]]);
    expect(exit.mock.calls).toEqual([[{ ptyId: "p1", exitCode: 0, signal: undefined }]]);
  });

  it("reports a reconnect only after a drop, never on the first open", () => {
    const fake = fakeLink();
    const bridge = corePtyBridgeFor(fake.link, "core_reconnect");
    const reattach = vi.fn();
    bridge.onReconnect(reattach);

    fake.setConnected(true);
    expect(reattach).not.toHaveBeenCalled();

    fake.setConnected(false);
    fake.setConnected(true);
    expect(reattach).toHaveBeenCalledTimes(1);

    fake.setConnected(true);
    expect(reattach).toHaveBeenCalledTimes(1);
  });

  it("asks its Core for a pty's stream, and gives it back", async () => {
    const f = fakeLink();
    const bridge = corePtyBridgeFor(f.link, "core_sub");

    f.answers({ type: "ptySubscribeAck", ptyId: "p1", subscribed: true, holding: true });
    await bridge.subscribe("p1", { catchUp: true });
    f.answers({ type: "ptyUnsubscribeAck", ptyId: "p1", subscribed: false });
    await bridge.unsubscribe("p1");

    // A Core streams a pty only to the connections that asked (issue 142); this
    // pair is the whole of what a pane does about that.
    expect(f.sent.map((s) => s.frame)).toEqual([
      { type: "ptySubscribe", ptyId: "p1", catchUp: true },
      { type: "ptyUnsubscribe", ptyId: "p1" },
    ]);
    expect(f.sent.every((s) => s.coreId === "core_sub")).toBe(true);
  });
});
