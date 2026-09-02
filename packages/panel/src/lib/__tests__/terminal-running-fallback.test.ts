import { describe, expect, it } from "vitest";
import {
  advanceTerminalRunningFallback,
  IDLE_TERMINAL_RUNNING_FALLBACK,
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
 * drop-path write, each one resurrecting `running` on a finished Session.
 */
function drive(
  script: Array<{ data: string; status: string }>,
  opts: { hooksReportTurnStart?: boolean } = {},
) {
  let state: TerminalRunningFallback = IDLE_TERMINAL_RUNNING_FALLBACK;
  const posts: string[] = [];
  for (const step of script) {
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
    // onData (it is written straight to the pty). Neither starts a turn.
    const run = drive([
      { data: "\x1b[200~/home/core/repos/control/README.md\x1b[201~", status: "finished" },
      { data: "\x1b[200~one\ntwo\n\x1b[201~", status: "finished" },
    ]);
    expect(run.posts).toEqual([]);
    expect(run.state.turn.composed).toContain("README.md");
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
    // The pane un-latches in its catch; from there the next real prompt must
    // post again rather than be swallowed by a latch that never opened a row.
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
});
