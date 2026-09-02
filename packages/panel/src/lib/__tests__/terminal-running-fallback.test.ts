import { describe, expect, it } from "vitest";
import {
  advanceTerminalRunningFallback,
  IDLE_TERMINAL_RUNNING_FALLBACK,
  noteTerminalWrite,
  type TerminalRunningFallback,
} from "../task-status-sync";

/**
 * Issue 386. `TerminalPane`'s `onData` handler is one call to
 * `advanceTerminalRunningFallback` per chunk, and `postRunning` is the PATCH
 * that flips the Session's card to `running`. These are that handler's story
 * scripts: a pane whose Session reports no turn START (Cursor CLI always,
 * Codex until its hooks are reviewed), driven chunk by chunk with the row's
 * status as the Core last reported it.
 *
 * The bug was the latch re-arming on "not currently running" alone, which made
 * every CR/LF after settlement a turn start — a stray Enter, a paste, a
 * drop-path write, each one resurrecting `running` on a finished Session. The
 * turn state is the gate that replaced it, so these scripts are also where its
 * two failure directions are held apart: a cancelled line must not post, and a
 * turn whose bytes never came through `onData` must.
 */
type Chunk = { data: string; status: string } | { write: string };

function drive(
  script: Chunk[],
  opts: { hooksReportTurnStart?: boolean; from?: TerminalRunningFallback } = {},
) {
  let state: TerminalRunningFallback = opts.from ?? IDLE_TERMINAL_RUNNING_FALLBACK;
  const posts: string[] = [];
  for (const step of script) {
    // `write` is the pane's `writeToPty`: bytes it sends on the operator's
    // behalf, which never pass through xterm's keyboard.
    if ("write" in step) {
      state = noteTerminalWrite(state, step.write);
      continue;
    }
    const next = advanceTerminalRunningFallback(state, {
      data: step.data,
      currentStatus: step.status,
      hooksReportTurnStart: opts.hooksReportTurnStart ?? false,
    });
    state = next.state;
    if (next.postRunning) posts.push(step.data);
  }
  return { state, posts };
}

describe("the Enter→running fallback after a Session settles", () => {
  it("does not PATCH running when the operator presses Enter on a finished Session", () => {
    // Acceptance 1. The turn ran, `stop` flipped the row to finished, and the
    // operator taps Enter at the harness's idle prompt — twice, because the
    // latch must not open on the second one either.
    const run = drive([
      { data: "review this\r", status: "ready" },
      { data: "\r", status: "finished" },
      { data: "\r", status: "finished" },
      { data: "\n", status: "finished" },
    ]);
    expect(run.posts).toEqual(["review this\r"]);
  });

  it("does not PATCH running when a path is pasted into a finished Session", () => {
    // Acceptance 1, the other half. A path pasted at the idle prompt arrives
    // bracketed; a path dropped from the Panel's own UI does not even reach
    // onData. Neither starts a turn.
    const run = drive([
      { data: "\x1b[200~/home/core/repos/control/README.md\x1b[201~", status: "finished" },
      { data: "\x1b[200~one\ntwo\n\x1b[201~", status: "finished" },
    ]);
    expect(run.posts).toEqual([]);
    expect(run.state.turn.composed).toContain("README.md");
  });

  it("does not PATCH running when the operator types, cancels, then presses Enter", () => {
    // Acceptance 1's residual case. At a FINISHED Session the operator starts a
    // prompt, changes their mind, backs out — Ctrl+C, or Esc, which is how you
    // leave the Codex composer — and taps Enter at the now-empty prompt. The
    // line the harness is holding is empty; the pane's mirror of it must be too.
    for (const cancel of ["\x03", "\x15", "\x17", "\x1b"]) {
      const run = drive([
        { data: "hello", status: "finished" },
        { data: cancel, status: "finished" },
        { data: "\r", status: "finished" },
      ]);
      expect(run.posts, `cancel ${JSON.stringify(cancel)}`).toEqual([]);
    }
    // Delete, likewise, when it takes the only character on the line.
    const del = drive([
      { data: "h", status: "finished" },
      { data: "\x1b[3~", status: "finished" },
      { data: "\r", status: "finished" },
    ]);
    expect(del.posts).toEqual([]);
  });

  it("still PATCHes running when an edit leaves text on the line", () => {
    // The other direction of the same finding: cancels must not be modelled so
    // bluntly that a real prompt stops posting. Ctrl+W takes a word, Delete
    // takes a character, and what is left is still a turn.
    const run = drive([
      { data: "fix the login bug", status: "finished" },
      { data: "\x17", status: "finished" },
      { data: "\x1b[3~", status: "finished" },
      { data: "\r", status: "finished" },
    ]);
    expect(run.posts).toEqual(["\r"]);
  });

  it("still PATCHes running when the operator actually starts a new turn", () => {
    // Acceptance 2. The Session finished, and the operator types a real prompt
    // — pasted path and all — then presses Enter. Nothing else will report
    // this turn's start, so the fallback must.
    const run = drive([
      { data: "first prompt\r", status: "ready" },
      { data: "\r", status: "finished" },
      { data: "n", status: "finished" },
      { data: "ow do ", status: "finished" },
      { data: "\x1b[200~./notes.md\x1b[201~", status: "finished" },
      { data: "\r", status: "finished" },
    ]);
    expect(run.posts).toEqual(["first prompt\r", "\r"]);
  });

  it("PATCHes running for a turn whose bytes never came through onData", () => {
    // Acceptance 2's gap. Two ways to start a turn without typing it:
    //
    //   1. A path dropped from the Panel's own UI. `wireTerminalFileDrop`
    //      calls `writeToPty` → `ptyApi.write`, so the bytes reach the pty
    //      without passing through xterm's keyboard — `onData` never sees them.
    //   2. Up-arrow prompt recall, where the harness puts a previous prompt
    //      back on the line and the pane only ever sees the cursor key.
    //
    // Either way the Enter that follows starts real work on a Session whose
    // hooks will not say so, so the card must move.
    const dropped = drive([
      { data: "first prompt\r", status: "ready" },
      { write: "/home/core/repos/control " },
      { data: "\r", status: "finished" },
    ]);
    expect(dropped.posts).toEqual(["first prompt\r", "\r"]);

    const recalled = drive([
      { data: "first prompt\r", status: "ready" },
      { data: "\x1b[A", status: "finished" },
      { data: "\r", status: "finished" },
    ]);
    expect(recalled.posts).toEqual(["first prompt\r", "\r"]);

    // …and a drop the operator then backs out of is not a turn. Cmd+Backspace
    // reaches the pty through `writeToPty` too, as `\x15`.
    const abandoned = drive([
      { write: "/home/core/repos/control " },
      { write: "\x15" },
      { data: "\r", status: "finished" },
    ]);
    expect(abandoned.posts).toEqual([]);
  });

  it("keeps a paste marker split across chunks out of the composition", () => {
    // Split at `ESC[200`, the `200` used to land in the composition as text —
    // enough to make the next Enter post `running` on a finished Session.
    const run = drive([
      { data: "\x1b[200", status: "finished" },
      { data: "~/a/b\x1b[201~", status: "finished" },
    ]);
    expect(run.posts).toEqual([]);
    expect(run.state.turn.composed).toBe("/a/b");
    expect(run.state.turn.pasting).toBe(false);
  });

  it("posts once per turn while the Session is running", () => {
    // The latch: a submit mid-turn (an answer to the harness's own prompt)
    // must not re-PATCH a row that is already running.
    const run = drive([
      { data: "go\r", status: "ready" },
      { data: "yes\r", status: "running" },
      { data: "more\r", status: "running" },
    ]);
    expect(run.posts).toEqual(["go\r"]);
  });

  it("re-arms across turns, so every genuine prompt updates the card", () => {
    const run = drive([
      { data: "one\r", status: "ready" },
      { data: "two\r", status: "finished" },
      { data: "three\r", status: "finished" },
    ]);
    expect(run.posts).toEqual(["one\r", "two\r", "three\r"]);
  });

  it("stays out of the way when the Session's hooks report the turn's start", () => {
    const run = drive(
      [
        { data: "a real prompt\r", status: "ready" },
        { data: "\r", status: "finished" },
      ],
      { hooksReportTurnStart: true },
    );
    expect(run.posts).toEqual([]);
  });

  it("lets a failed PATCH be retried by the next submitted turn", () => {
    // The pane un-latches in the status mutation's own catch; from there the
    // next real prompt must post again rather than be swallowed by a latch
    // that never opened a row.
    let state = advanceTerminalRunningFallback(IDLE_TERMINAL_RUNNING_FALLBACK, {
      data: "go\r",
      currentStatus: "ready",
      hooksReportTurnStart: false,
    }).state;
    state = { ...state, posted: false };
    const retry = advanceTerminalRunningFallback(state, {
      data: "go again\r",
      currentStatus: "ready",
      hooksReportTurnStart: false,
    });
    expect(retry.postRunning).toBe(true);
  });

  it("starts every pty from the idle state, carrying nothing over", () => {
    // The pane resets to IDLE_TERMINAL_RUNNING_FALLBACK in `wireTerminalInput`,
    // which is re-called per pty. Without it a half-typed line survives into
    // the next harness process — the first stray Enter there posts `running` —
    // and worse, an unclosed `pasting` latch swallows every `\r` for the life
    // of the pane, killing the fallback outright.
    const halfTyped = drive([{ data: "half a prompt", status: "finished" }]).state;
    const pasting = drive([{ data: "\x1b[200~/a/b", status: "finished" }]).state;
    expect(pasting.turn.pasting).toBe(true);

    // Carried into the next pty, each one is a bug…
    expect(drive([{ data: "\r", status: "finished" }], { from: halfTyped }).posts).toEqual(["\r"]);
    expect(drive([{ data: "type\r", status: "finished" }], { from: pasting }).posts).toEqual([]);

    // …and from the idle state the pane resets to, neither is.
    expect(drive([{ data: "\r", status: "finished" }]).posts).toEqual([]);
    expect(drive([{ data: "type\r", status: "finished" }]).posts).toEqual(["type\r"]);
  });
});
