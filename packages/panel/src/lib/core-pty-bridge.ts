// One Core's PTY transport, over the tab's panel link.
//
// A terminal pane doesn't know it is talking across two hops. It calls
// spawn/write/resize/kill/replay and subscribes to output, exactly as it did
// when the PTY lived in the same process. This module is where the addressing
// happens: every call is tagged with the Core it belongs to on the way down,
// and every `{coreId, ptyId, …}` push is filtered back to the bound Core on the
// way up, so everything downstream stays coreId-agnostic.
//
// The bridge is a stable object per (link × coreId). That identity matters:
// `getPtyStreamRouter`'s WeakMap keys off it, so all of a Core's panes share
// exactly one output subscription and one reconnect reattach, demuxed by ptyId.

import type { PanelLinkClient } from "./panel-link-client";
import type { CoreLinkPtyReplay, CoreLinkPtySpawnOptions } from "@actana/sdk/core-link-frames";
import type { CoreLinkAnswer as Answer } from "~/shared/panel-link";

export type CorePtyBridge = {
  spawn: (
    opts: CoreLinkPtySpawnOptions,
  ) => Promise<{ ptyId: string; hooksReportTurnStart: boolean }>;
  /**
   * Hand the owning Core a prompt read off the terminal, for a harness whose
   * hooks will not report one (issue 84). It patches nothing — the Core takes
   * it as the trigger to name an unnamed Session, which is the only way a
   * Core-owned Cursor Session gets a title at all.
   */
  submitPrompt: (taskId: string, prompt: string) => Promise<boolean>;
  write: (ptyId: string, data: string) => Promise<boolean>;
  resize: (ptyId: string, cols: number, rows: number) => Promise<boolean>;
  kill: (ptyId: string) => Promise<boolean>;
  /** The output this pty has buffered — all of it, or the tail past `sinceSeq`. */
  replay: (ptyId: string, sinceSeq?: number) => Promise<CoreLinkPtyReplay>;
  /**
   * Start receiving one pty's output (issue 142). A Core sends a pty's stream
   * only to the connections that asked for it, so a pane that does not claim
   * its pty renders nothing at all — this is what `onData`/`onExit` are gated
   * on, not a filter over everything the machine is producing.
   *
   * `catchUp` says a `replay` for this pty follows, and asks the Core to hold
   * the live stream until it has been served so the two never land out of
   * order. The claim path always sets it; see `pty-stream-router`.
   *
   * The link remembers what it is subscribed to and re-asks on every reconnect,
   * so a pane claims once and keeps its stream across a dropped link.
   */
  subscribe: (ptyId: string, opts?: { catchUp?: boolean }) => Promise<void>;
  /** Stop receiving one pty's output. Idempotent, like {@link subscribe}. */
  unsubscribe: (ptyId: string) => Promise<void>;
  findByTask: (taskId: string) => Promise<{ ptyId: string | null }>;
  onData: (cb: (msg: { ptyId: string; data: string; seq: number }) => void) => () => void;
  onExit: (
    cb: (msg: { ptyId: string; exitCode: number; signal?: number }) => void,
  ) => () => void;
  /**
   * The link came back after a drop. Not "the link opened" — a first open has
   * nothing to reattach to, and firing there would replay a scrollback the pane
   * is already painting.
   */
  onReconnect: (cb: () => void) => () => void;
};

const bridges = new WeakMap<PanelLinkClient, Map<string, CorePtyBridge>>();

/**
 * @internal Reached through `getCorePtyBridge` (or the panel bridge's `pty`);
 * exported here for the bridge that owns the link, and for tests.
 *
 * The stable {@link CorePtyBridge} for one Core on one link. Created on first
 * use, which is also when this tab starts watching the Core — a tab with no
 * terminal open on a Core doesn't pay for its stream.
 */
export function corePtyBridgeFor(link: PanelLinkClient, coreId: string): CorePtyBridge {
  let perCore = bridges.get(link);
  if (!perCore) {
    perCore = new Map();
    bridges.set(link, perCore);
  }
  const cached = perCore.get(coreId);
  if (cached) return cached;
  const bridge = createCorePtyBridge(link, coreId);
  perCore.set(coreId, bridge);
  return bridge;
}

function createCorePtyBridge(link: PanelLinkClient, coreId: string): CorePtyBridge {
  // PTY pushes ride the Core's stream, so this tab must be watching it. The
  // hold is never released: the bridge lives as long as the link, and so do
  // the panes' claims on it.
  link.watch(coreId);
  return {
    async spawn(opts) {
      const { ptyId, hooksReportTurnStart } = await link.request<Answer<"spawned">>(coreId, {
        type: "spawn",
        opts,
      });
      // A Core that predates issue 84 answers without the field. Reading that
      // as "no" keeps the terminal-input fallback armed, which is the safe
      // direction: a redundant `running` write, never a Session with no status
      // signal at all.
      return { ptyId, hooksReportTurnStart: hooksReportTurnStart === true };
    },
    submitPrompt: async (taskId, prompt) =>
      (
        await link.request<Answer<"harnessPromptResult">>(coreId, {
          type: "harnessPrompt",
          taskId,
          prompt,
        })
      ).accepted,
    write: async (ptyId, data) =>
      (await link.request<Answer<"writeResult">>(coreId, { type: "write", ptyId, data })).ok,
    resize: async (ptyId, cols, rows) =>
      (await link.request<Answer<"resizeResult">>(coreId, { type: "resize", ptyId, cols, rows }))
        .ok,
    kill: async (ptyId) =>
      (await link.request<Answer<"killResult">>(coreId, { type: "kill", ptyId })).ok,
    replay: async (ptyId, sinceSeq) => {
      const result = await link.request<Answer<"replayResult">>(coreId, {
        type: "replay",
        ptyId,
        sinceSeq,
      });
      return { data: result.data, nextSeq: result.nextSeq, from: result.from };
    },
    // Through the link's own claim bookkeeping rather than a bare request: the
    // service gives a tab's claims back when its socket dies, so the set has to
    // live somewhere that sees the link come back and re-ask.
    subscribe: (ptyId, opts) => link.ptySubscribe(coreId, ptyId, opts),
    unsubscribe: (ptyId) => link.ptyUnsubscribe(coreId, ptyId),
    findByTask: async (taskId) => {
      const result = await link.request<Answer<"findByTaskResult">>(coreId, {
        type: "findByTask",
        taskId,
      });
      return { ptyId: result.ptyId };
    },
    onData: (cb) =>
      link.onPtyData((msg) => {
        if (msg.coreId !== coreId) return;
        cb({ ptyId: msg.ptyId, data: msg.data, seq: msg.seq });
      }),
    onExit: (cb) =>
      link.onPtyExit((msg) => {
        if (msg.coreId !== coreId) return;
        cb({ ptyId: msg.ptyId, exitCode: msg.exitCode, signal: msg.signal });
      }),
    onReconnect: (cb) => {
      let wasDown = false;
      return link.onConnectionChange((connected) => {
        if (!connected) {
          wasDown = true;
          return;
        }
        if (!wasDown) return;
        wasDown = false;
        cb();
      });
    },
  };
}
