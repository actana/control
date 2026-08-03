import { describe, expect, it, vi } from "vitest";
import {
  createPtyStreamRouter,
  getPtyStreamRouter,
  type PtyDataMsg,
  type PtyExitMsg,
  type PtyStreamTransport,
} from "../pty-stream-router";

function makeTransport(opts: { replay?: PtyReplayFn } = {}) {
  const dataCbs: Array<(msg: PtyDataMsg) => void> = [];
  const exitCbs: Array<(msg: PtyExitMsg) => void> = [];
  const reconnectCbs: Array<() => void> = [];
  const transport: PtyStreamTransport = {
    onData: (cb) => {
      dataCbs.push(cb);
      return () => undefined;
    },
    onExit: (cb) => {
      exitCbs.push(cb);
      return () => undefined;
    },
    ...(opts.replay
      ? {
          replay: opts.replay,
          onReconnect: (cb: () => void) => {
            reconnectCbs.push(cb);
            return () => undefined;
          },
        }
      : {}),
  };
  return {
    transport,
    emitData: (msg: PtyDataMsg) => dataCbs.forEach((cb) => cb(msg)),
    emitExit: (msg: PtyExitMsg) => exitCbs.forEach((cb) => cb(msg)),
    reconnect: () => reconnectCbs.forEach((cb) => cb()),
    listenerCount: () => dataCbs.length + exitCbs.length,
  };
}

type PtyReplayFn = (
  ptyId: string,
  sinceSeq?: number,
) => Promise<{ data: string; nextSeq: number; from?: number }>;

describe("pty-stream-router", () => {
  it("subscribes to the transport exactly once regardless of claims", () => {
    const t = makeTransport();
    const router = createPtyStreamRouter(t.transport);
    router.claim("a", { data: () => undefined, exit: () => undefined });
    router.claim("b", { data: () => undefined, exit: () => undefined });
    expect(t.listenerCount()).toBe(2); // one onData + one onExit
  });

  it("routes data and exit to the claiming handlers only", () => {
    const t = makeTransport();
    const router = createPtyStreamRouter(t.transport);
    const got: string[] = [];
    router.claim("a", {
      data: (msg) => got.push(`a-data:${msg.data}`),
      exit: (msg) => got.push(`a-exit:${msg.exitCode}`),
    });
    router.claim("b", {
      data: (msg) => got.push(`b-data:${msg.data}`),
      exit: () => got.push("b-exit"),
    });
    t.emitData({ ptyId: "a", data: "x", seq: 1 });
    t.emitData({ ptyId: "b", data: "y", seq: 1 });
    t.emitExit({ ptyId: "a", exitCode: 0 });
    expect(got).toEqual(["a-data:x", "b-data:y", "a-exit:0"]);
  });

  it("buffers unclaimed output and hands it over once, in order", () => {
    const t = makeTransport();
    const router = createPtyStreamRouter(t.transport);
    t.emitData({ ptyId: "new", data: "hel", seq: 1 });
    t.emitData({ ptyId: "new", data: "lo", seq: 2 });
    const pending = router.takePendingData("new");
    expect(pending.map((c) => c.data).join("")).toBe("hello");
    expect(pending.map((c) => c.seq)).toEqual([1, 2]);
    expect(router.takePendingData("new")).toEqual([]);
  });

  it("buffers an unclaimed exit and hands it over once", () => {
    const t = makeTransport();
    const router = createPtyStreamRouter(t.transport);
    t.emitExit({ ptyId: "gone", exitCode: 137, signal: 9 });
    expect(router.takePendingExit("gone")).toEqual({ ptyId: "gone", exitCode: 137, signal: 9 });
    expect(router.takePendingExit("gone")).toBeNull();
  });

  it("stops buffering once claimed and resumes when unclaimed", () => {
    const t = makeTransport();
    const router = createPtyStreamRouter(t.transport);
    const got: string[] = [];
    const unclaim = router.claim("a", {
      data: (msg) => got.push(msg.data),
      exit: () => undefined,
    });
    t.emitData({ ptyId: "a", data: "live", seq: 1 });
    expect(got).toEqual(["live"]);
    expect(router.takePendingData("a")).toEqual([]);
    unclaim();
    t.emitData({ ptyId: "a", data: "buffered", seq: 2 });
    expect(got).toEqual(["live"]);
    expect(router.takePendingData("a").map((c) => c.data)).toEqual(["buffered"]);
  });

  it("a stale unclaim cannot detach a successor claim", () => {
    const t = makeTransport();
    const router = createPtyStreamRouter(t.transport);
    const got: string[] = [];
    const unclaimOld = router.claim("a", { data: () => got.push("old"), exit: () => undefined });
    router.claim("a", { data: () => got.push("new"), exit: () => undefined });
    unclaimOld(); // tears down the OLD claim's handle only — the new claim stays
    t.emitData({ ptyId: "a", data: "x", seq: 1 });
    expect(got).toEqual(["new"]);
  });

  it("bounds buffered output per pty", () => {
    const t = makeTransport();
    const router = createPtyStreamRouter(t.transport);
    t.emitData({ ptyId: "a", data: "x".repeat(64_000), seq: 1 });
    t.emitData({ ptyId: "a", data: "tail", seq: 2 });
    // Oldest chunk dropped to stay under the cap; the newest survives.
    expect(router.takePendingData("a").map((c) => c.seq)).toEqual([2]);
  });

  it("evicts the oldest unclaimed ptys beyond the cap", () => {
    const t = makeTransport();
    const router = createPtyStreamRouter(t.transport);
    for (let i = 0; i < 70; i += 1) {
      t.emitData({ ptyId: `pty-${i}`, data: "x", seq: 1 });
    }
    expect(router.takePendingData("pty-0")).toEqual([]);
    expect(router.takePendingData("pty-69").map((c) => c.data)).toEqual(["x"]);
  });

  // ─── Reattach after a dropped panel link ──────────────────────────────────
  //
  // While the link is down the Harness keeps running the PTY and buffering its
  // output. On reconnect the tab is behind by however long the gap lasted, and
  // the terminal on screen must end up showing exactly what the PTY produced —
  // no repeat of what's already painted, no hole where the gap was.

  it("replays each claimed pty from where it left off and writes only the gap", async () => {
    const calls: Array<[string, number | undefined]> = [];
    const t = makeTransport({
      replay: async (ptyId, sinceSeq) => {
        calls.push([ptyId, sinceSeq]);
        return { data: "missed", nextSeq: 5, from: sinceSeq };
      },
    });
    const router = createPtyStreamRouter(t.transport);
    const got: string[] = [];
    router.claim("a", { data: (msg) => got.push(msg.data), exit: () => undefined });
    t.emitData({ ptyId: "a", data: "before", seq: 3 });

    t.reconnect();
    await vi.waitFor(() => expect(got).toEqual(["before", "missed"]));
    // Resumes one past the last seq it painted.
    expect(calls).toEqual([["a", 4]]);
  });

  it("resumes past scrollback the pane painted itself, not from the top", async () => {
    // The pane does its own replay when it first attaches. If the link drops
    // before the pty says anything new, a reattach that started from zero would
    // paint that whole scrollback a second time.
    const calls: Array<number | undefined> = [];
    const t = makeTransport({
      replay: async (_ptyId, sinceSeq) => {
        calls.push(sinceSeq);
        return { data: "", nextSeq: 7 };
      },
    });
    const router = createPtyStreamRouter(t.transport);
    router.claim("a", { data: () => undefined, exit: () => undefined });
    router.noteReplayed("a", 7); // what the pane's own replay reported

    t.reconnect();
    await vi.waitFor(() => expect(calls).toEqual([7]));
  });

  it("resumes past output it handed the pane out of its own buffer", async () => {
    // Output that arrived before the pane claimed the pty is drained through
    // takePendingData and painted — so it is on screen and must not repeat.
    const calls: Array<number | undefined> = [];
    const t = makeTransport({
      replay: async (_ptyId, sinceSeq) => {
        calls.push(sinceSeq);
        return { data: "", nextSeq: 3 };
      },
    });
    const router = createPtyStreamRouter(t.transport);
    t.emitData({ ptyId: "a", data: "early", seq: 2 });
    router.takePendingData("a");
    router.claim("a", { data: () => undefined, exit: () => undefined });

    t.reconnect();
    await vi.waitFor(() => expect(calls).toEqual([3]));
  });

  it("asks for the whole scrollback for a pty that has shown nothing yet", async () => {
    const calls: Array<[string, number | undefined]> = [];
    const t = makeTransport({
      replay: async (ptyId, sinceSeq) => {
        calls.push([ptyId, sinceSeq]);
        return { data: "", nextSeq: 0 };
      },
    });
    const router = createPtyStreamRouter(t.transport);
    router.claim("fresh", { data: () => undefined, exit: () => undefined });
    t.reconnect();
    await vi.waitFor(() => expect(calls).toEqual([["fresh", 0]]));
  });

  it("does not double-paint output that arrives live while the replay is in flight", async () => {
    // The link comes back and the Core resumes pushing immediately — those
    // chunks are in the replay window too. Whichever wins the race, the screen
    // must show each byte once, in order.
    let release: (() => void) | null = null;
    const t = makeTransport({
      replay: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return { data: "gap-4gap-5", nextSeq: 6, from: 4 };
      },
    });
    const router = createPtyStreamRouter(t.transport);
    const got: string[] = [];
    router.claim("a", { data: (msg) => got.push(msg.data), exit: () => undefined });
    t.emitData({ ptyId: "a", data: "painted-3", seq: 3 });

    t.reconnect();
    // The Core pushes seq 5 live before its own replay answer comes back, then
    // keeps going.
    t.emitData({ ptyId: "a", data: "gap-5", seq: 5 });
    t.emitData({ ptyId: "a", data: "live-6", seq: 6 });
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();

    await vi.waitFor(() => expect(got.join("")).toBe("painted-3gap-4gap-5live-6"));
  });

  it("delivers an exit that lands during a reattach, after the replayed gap", async () => {
    let release: (() => void) | null = null;
    const t = makeTransport({
      replay: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return { data: "last words", nextSeq: 2, from: 1 };
      },
    });
    const router = createPtyStreamRouter(t.transport);
    const got: string[] = [];
    router.claim("a", {
      data: (msg) => got.push(msg.data),
      exit: (msg) => got.push(`exit:${msg.exitCode}`),
    });
    t.emitData({ ptyId: "a", data: "before", seq: 0 });

    t.reconnect();
    t.emitExit({ ptyId: "a", exitCode: 3 });
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();

    await vi.waitFor(() => expect(got).toEqual(["before", "last words", "exit:3"]));
  });

  it("resets the surface when the Harness ring rolled past the cursor", async () => {
    // A long outage: the bytes right after what we painted are gone for good,
    // so splicing the tail on would render a lie. Repaint instead.
    const t = makeTransport({
      replay: async () => ({ data: "much later", nextSeq: 900, from: 800 }),
    });
    const router = createPtyStreamRouter(t.transport);
    const got: string[] = [];
    router.claim("a", {
      data: (msg) => got.push(msg.data),
      exit: () => undefined,
      reset: () => got.push("<reset>"),
    });
    t.emitData({ ptyId: "a", data: "before", seq: 3 });

    t.reconnect();
    await vi.waitFor(() => expect(got).toEqual(["before", "<reset>", "much later"]));
  });

  it("writes nothing when the pty produced nothing during the gap", async () => {
    const t = makeTransport({ replay: async () => ({ data: "", nextSeq: 4 }) });
    const router = createPtyStreamRouter(t.transport);
    const got: string[] = [];
    router.claim("a", {
      data: (msg) => got.push(msg.data),
      exit: () => undefined,
      reset: () => got.push("<reset>"),
    });
    t.emitData({ ptyId: "a", data: "before", seq: 3 });

    t.reconnect();
    await vi.waitFor(() => expect(t.listenerCount()).toBe(2));
    expect(got).toEqual(["before"]);
  });

  it("does not replay a pty that was unclaimed before the link came back", async () => {
    const calls: string[] = [];
    const t = makeTransport({
      replay: async (ptyId) => {
        calls.push(ptyId);
        return { data: "x", nextSeq: 1, from: 0 };
      },
    });
    const router = createPtyStreamRouter(t.transport);
    const unclaim = router.claim("a", { data: () => undefined, exit: () => undefined });
    unclaim();
    t.reconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
  });

  it("keeps the terminal alive when the replay request fails", async () => {
    const t = makeTransport({ replay: async () => Promise.reject(new Error("link down again")) });
    const router = createPtyStreamRouter(t.transport);
    const got: string[] = [];
    router.claim("a", { data: (msg) => got.push(msg.data), exit: () => undefined });
    t.reconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.emitData({ ptyId: "a", data: "still here", seq: 9 });
    expect(got).toEqual(["still here"]);
  });

  it("getPtyStreamRouter returns the same router per transport", () => {
    const t1 = makeTransport();
    const t2 = makeTransport();
    expect(getPtyStreamRouter(t1.transport)).toBe(getPtyStreamRouter(t1.transport));
    expect(getPtyStreamRouter(t1.transport)).not.toBe(getPtyStreamRouter(t2.transport));
    expect(t1.listenerCount()).toBe(2);
  });
});
