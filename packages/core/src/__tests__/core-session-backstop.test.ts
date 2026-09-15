import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapCoreDb } from "../core-db-bootstrap";
import {
  configureCoreMutationStore,
  coreMutationStore,
  disposeCoreMutationStore,
} from "../core-mutation-store";
import {
  configureCoreQueryStore,
  coreQueryStore,
  disposeCoreQueryStore,
  listActiveTasks,
} from "../core-query-store";
import {
  appendEvent,
  configureEventLogStore,
  disposeEventLogStore,
  getLastEventId,
  readEventTail,
} from "../event-log-store";
import { CoreTaskWriter } from "../core-task-writer";
import { CoreSessionBackstop } from "../core-session-backstop";
import { PtyOutputActivityWatcher } from "../pty-output-activity";
import { CoreHarnessStatus } from "../core-harness-status";
import type { HarnessHookBody } from "@actana/shared/harness-hook-pipeline";
import { clearSubagentActivity } from "@actana/shared/subagent-activity";

/**
 * The log's tip, insisting there is a log. `getLastEventId` answers `null` for
 * a store it cannot reach (#495 gate review, addendum blocker 7); in this file
 * the store is a real temp DB, so a `null` is a broken fixture and not a case
 * worth folding into `0` — folding it would make an assertion pass for the
 * wrong reason.
 */
function lastEventId(): number {
  const id = getLastEventId();
  if (id === null) throw new Error("this test's event-log store is unavailable");
  return id;
}

// The backstop nobody has to arm (issue 243 part 2), against this Core's real
// SQLite and event log.
//
// The case that matters is the one the drain backstop cannot reach: a turn
// whose terminal `Stop` was the POST that dropped. Nothing was held, nothing
// was armed, no subagent was tracked — the row simply says `running` with no
// timer watching it. Every test below starts from exactly that row.

const QUIET_MS = 15 * 60 * 1000;
const MINUTE = 60 * 1000;
/** The idle-redraw window this file leaves at its production default. */
const IDLE_MS = 8 * MINUTE;
/** How often a painting TUI writes a frame. */
const FRAME_MS = 1000;

describe("settling a turn whose end nobody reported", () => {
  let userDataDir: string;
  let writer: CoreTaskWriter;
  let nowMs: number;
  let livePtys: Set<string>;

  const makeBackstop = () =>
    new CoreSessionBackstop({
      listActiveTasks,
      writer,
      hasLivePty: (taskId) => livePtys.has(taskId),
      now: () => nowMs,
      quietMs: QUIET_MS,
    });

  const insert = (taskId: string, status: string) => {
    coreMutationStore.mutateTask({
      op: "create",
      taskId,
      projectId: "p1",
      title: taskId,
      agent: "claude-code",
      status,
    });
    livePtys.add(taskId);
  };
  const statusOf = (taskId: string) => coreQueryStore.getTask(taskId)?.status;
  const kindsSince = (eventId: number) => readEventTail(eventId, 100).map((e) => e.kind);

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-session-backstop-"));
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
    configureEventLogStore(userDataDir);
    writer = new CoreTaskWriter({
      mutationPort: coreMutationStore,
      queryPort: coreQueryStore,
      eventLog: { appendEvent, getLastEventId, readEventTail },
    });
    coreMutationStore.mutateProject({
      op: "create",
      projectId: "p1",
      name: "Warehouse",
      path: userDataDir,
    });
    nowMs = Date.now();
    livePtys = new Set();
  });

  afterEach(() => {
    clearSubagentActivity("t-1");
    disposeCoreMutationStore();
    disposeCoreQueryStore();
    disposeEventLogStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("finishes a Session that has gone quiet, with nothing having armed it", () => {
    insert("t-1", "running");
    const backstop = makeBackstop();
    const before = lastEventId();

    // No hook was ever seen for this row, so no timer exists for it anywhere —
    // which is precisely the state a lost `Stop` leaves behind.
    nowMs += QUIET_MS + MINUTE;
    expect(backstop.sweepOnce()).toEqual(["t-1"]);

    expect(statusOf("t-1")).toBe("finished");
    // The finish the operator never got: card, toast and notification all
    // route on this event (ADR 0008).
    expect(kindsSince(before)).toContain("session:finished");
  });

  it("leaves a turn alone while its harness is still talking", () => {
    insert("t-1", "running");
    const backstop = makeBackstop();

    // A long turn: hours of work, output all the way through. Every chunk of
    // PTY output and every hook lands here.
    for (let minute = 0; minute < 120; minute += 1) {
      nowMs += MINUTE;
      backstop.noteActivity("t-1");
      expect(backstop.sweepOnce()).toEqual([]);
    }
    expect(statusOf("t-1")).toBe("running");

    // Then the turn ends and its `Stop` drops. Nothing else is coming.
    nowMs += QUIET_MS + MINUTE;
    expect(backstop.sweepOnce()).toEqual(["t-1"]);
    expect(statusOf("t-1")).toBe("finished");
  });

  it("counts the row's own last write as the last thing heard from it", () => {
    // A Session this process has heard nothing about since boot — the restart
    // case — must not be settled for a silence that predates the Core.
    insert("t-1", "running");
    const backstop = makeBackstop();

    nowMs += QUIET_MS - MINUTE;
    expect(backstop.sweepOnce()).toEqual([]);
    nowMs += 2 * MINUTE;
    expect(backstop.sweepOnce()).toEqual(["t-1"]);
  });

  it("never settles a Session that is waiting on a human", () => {
    // `needs-input` may sit silent forever and still be true; a timer cannot
    // make it truer, and finishing it would hide a question.
    insert("t-1", "needs-input");
    const backstop = makeBackstop();

    nowMs += 10 * QUIET_MS;
    expect(backstop.sweepOnce()).toEqual([]);
    expect(statusOf("t-1")).toBe("needs-input");
  });

  it("calls a quiet Session with no PTY disconnected, not finished", () => {
    // No live PTY means the process went away without its exit being
    // recorded. That is not a finish, and it raises no finish notification.
    insert("t-1", "running");
    livePtys.delete("t-1");
    const backstop = makeBackstop();
    const before = lastEventId();

    nowMs += QUIET_MS + MINUTE;
    expect(backstop.sweepOnce()).toEqual(["t-1"]);
    expect(statusOf("t-1")).toBe("disconnected");
    expect(kindsSince(before)).not.toContain("session:finished");
  });

  it("settles a row once, and the next sweep finds nothing to do", () => {
    insert("t-1", "running");
    const backstop = makeBackstop();

    nowMs += QUIET_MS + MINUTE;
    expect(backstop.sweepOnce()).toEqual(["t-1"]);
    const after = lastEventId();

    nowMs += QUIET_MS;
    expect(backstop.sweepOnce()).toEqual([]);
    expect(lastEventId()).toBe(after);
  });

  it("settles every quiet Session, not just the first", () => {
    insert("t-1", "running");
    insert("t-2", "running");
    insert("t-3", "running");
    const backstop = makeBackstop();

    nowMs += QUIET_MS + MINUTE;
    backstop.noteActivity("t-2");
    expect(backstop.sweepOnce().sort()).toEqual(["t-1", "t-3"]);
    expect(statusOf("t-2")).toBe("running");
  });

  it("stops watching a Session whose PTY exit already settled it", () => {
    insert("t-1", "running");
    const backstop = makeBackstop();
    backstop.noteActivity("t-1");
    backstop.forget("t-1");

    // The exit path settles the row; the backstop must not then re-settle it.
    coreMutationStore.mutateTask({ op: "update", taskId: "t-1", status: "terminated" });
    nowMs += QUIET_MS + MINUTE;
    expect(backstop.sweepOnce()).toEqual([]);
    expect(statusOf("t-1")).toBe("terminated");
  });

  it("runs on a timer without holding the process open", () => {
    insert("t-1", "running");
    const backstop = makeBackstop();
    backstop.start();
    // Idempotent start, and a stop that can be called on a stopped instance —
    // the shutdown path calls it unconditionally.
    backstop.start();
    backstop.stop();
    backstop.stop();
    expect(statusOf("t-1")).toBe("running");
  });

  // ─── Issue 391: the harness that is idle and still painting ───
  //
  // The rule above reads any byte as work, and the harness whose hooks are not
  // arriving is exactly the harness whose TUI is still on screen: Codex before
  // `/hooks` has been reviewed paints a spinner and a clock for as long as the
  // process lives. Fifteen minutes of total silence never comes, so the card
  // claims `running` until a human edits the row. These pin both halves of the
  // acceptance: an idle harness settles on a window an operator can wait out,
  // and a turn that is still printing real output is never settled at all.
  describe("an idle TUI that never stops repainting", () => {
    /** Paint a spinner frame every second for `ms`, reporting each as a redraw. */
    const paintFor = (backstop: CoreSessionBackstop, ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
        nowMs += FRAME_MS;
        backstop.noteActivity("t-1", "redraw");
      }
    };

    it("settles inside the idle window, though the bytes never stop", () => {
      insert("t-1", "running");
      const backstop = makeBackstop();
      const before = lastEventId();

      // Seven minutes of clock. The old rule sees a chatty harness; this one
      // sees a screen on which nothing has happened — but not yet for long
      // enough.
      paintFor(backstop, 7 * MINUTE);
      expect(backstop.sweepOnce()).toEqual([]);
      expect(statusOf("t-1")).toBe("running");

      // Past eight, and one sweep is still not enough: the rule asks twice,
      // because one sweep is one sample of a screen.
      paintFor(backstop, 2 * MINUTE);
      expect(backstop.sweepOnce()).toEqual([]);
      expect(statusOf("t-1")).toBe("running");

      // The second sweep agrees, and the operator gets the finish nobody
      // reported — well inside the quarter-hour that would never have arrived.
      paintFor(backstop, MINUTE);
      expect(backstop.sweepOnce()).toEqual(["t-1"]);
      expect(statusOf("t-1")).toBe("finished");
      expect(kindsSince(before)).toContain("session:finished");
    });

    it("starts the two sweeps over when something new appears", () => {
      insert("t-1", "running");
      const backstop = makeBackstop();

      paintFor(backstop, IDLE_MS + MINUTE);
      expect(backstop.sweepOnce()).toEqual([]);

      // A tool result lands between the two sweeps. The run is broken, and the
      // window starts again from here.
      backstop.noteActivity("t-1", "output");
      paintFor(backstop, MINUTE);
      expect(backstop.sweepOnce()).toEqual([]);
      expect(statusOf("t-1")).toBe("running");
    });

    it("never settles a turn that is still putting things on screen", () => {
      insert("t-1", "running");
      const backstop = makeBackstop();

      // Two hours of real work: the spinner paints between bursts, and every
      // few minutes a tool result, a diff or a line of prose lands.
      for (let minute = 0; minute < 120; minute += 1) {
        paintFor(backstop, MINUTE);
        if (minute % 3 === 0) backstop.noteActivity("t-1", "output");
        expect(backstop.sweepOnce()).toEqual([]);
      }
      expect(statusOf("t-1")).toBe("running");
    });

    it("counts a hook as something happening, not a repaint", () => {
      insert("t-1", "running");
      const backstop = makeBackstop();

      // A long tool call: nothing but the spinner on screen, but the harness
      // is POSTing `PostToolUse` at the receiver, which calls this with `hook`.
      // A hook is never a repaint.
      for (let minute = 0; minute < 30; minute += 1) {
        paintFor(backstop, MINUTE);
        if (minute % 4 === 0) backstop.noteActivity("t-1", "hook");
        expect(backstop.sweepOnce()).toEqual([]);
      }
      expect(statusOf("t-1")).toBe("running");
    });

    it("leaves a Session that went properly silent to the long window", () => {
      // The short window is for a harness that is demonstrably still there.
      // One that stopped writing altogether keeps the fifteen-minute grace it
      // has always had — a silent worker is not an idle TUI.
      insert("t-1", "running");
      const backstop = makeBackstop();
      backstop.noteActivity("t-1", "redraw");

      nowMs += IDLE_MS + MINUTE;
      expect(backstop.sweepOnce()).toEqual([]);
      expect(statusOf("t-1")).toBe("running");

      nowMs += QUIET_MS;
      expect(backstop.sweepOnce()).toEqual(["t-1"]);
    });

    it("settles an idle harness whose PTY is gone as disconnected", () => {
      insert("t-1", "running");
      livePtys.delete("t-1");
      const backstop = makeBackstop();

      paintFor(backstop, IDLE_MS + MINUTE);
      expect(backstop.sweepOnce()).toEqual([]);
      paintFor(backstop, MINUTE);
      expect(backstop.sweepOnce()).toEqual(["t-1"]);
      expect(statusOf("t-1")).toBe("disconnected");
    });
  });

  // ─── Review of PR 455, finding 1: the finish this rule writes comes back ───
  //
  // The argument for a window shorter than fifteen minutes is that the mistake
  // is cheap. Nothing made it cheap: a `PostToolUse` maps to no status, and the
  // PTY output path writes none at all, so a row settled early stayed
  // `finished` until the operator's next prompt. The rule now takes it back —
  // and only the rule's own finishes, never anybody else's.
  describe("taking back a finish the idle rule wrote", () => {
    const paintFor = (backstop: CoreSessionBackstop, ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
        nowMs += FRAME_MS;
        backstop.noteActivity("t-1", "redraw");
      }
    };
    /**
     * A hook, through the real pipeline and then to the backstop — the wiring
     * `core-entry.ts` has, so what the pipeline does or does not write to the
     * row is part of what is under test.
     */
    const deliverHook = (backstop: CoreSessionBackstop, payload: HarnessHookBody) => {
      const harnessStatus = new CoreHarnessStatus({ writer });
      const result = harnessStatus.receiveHook("t-1", payload);
      if (result.ok && result.body?.ignored !== "foreign-session") {
        backstop.noteActivity("t-1", "hook");
      }
    };
    /** Paint until the idle rule has settled the row, and assert it did. */
    const settleByIdleRule = (backstop: CoreSessionBackstop) => {
      paintFor(backstop, IDLE_MS + MINUTE);
      expect(backstop.sweepOnce()).toEqual([]);
      paintFor(backstop, MINUTE);
      expect(backstop.sweepOnce()).toEqual(["t-1"]);
      expect(statusOf("t-1")).toBe("finished");
    };

    it("returns the row to running when real output finally arrives", () => {
      insert("t-1", "running");
      const backstop = makeBackstop();
      settleByIdleRule(backstop);

      // The six-minute build prints its first line. The turn was live all
      // along, and the card says so again without an operator touching it.
      nowMs += MINUTE;
      backstop.noteActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("running");
    });

    it("is not reopened by a Stop, which decided the row itself", () => {
      // Driven through the real pipeline rather than a synthetic kind: a
      // terminal `Stop` writes `finished` over this rule's `finished`, which
      // moves `updated_at` and ends the claim. The post-turn composer paint
      // that follows must find nothing to take back (review of PR 455, round
      // 3) — and the previous version of this test used a bare
      // `noteActivity(id, "hook")`, which never touches the pipeline, which is
      // how round 4's regression got past it.
      insert("t-1", "running");
      const backstop = makeBackstop();
      settleByIdleRule(backstop);
      const after = lastEventId();

      nowMs += 30 * 1000;
      deliverHook(backstop, { hook_event_name: "Stop" });
      expect(statusOf("t-1")).toBe("finished");

      nowMs += 30 * 1000;
      backstop.noteActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("finished");
      // The `Stop`'s own write is a `finished` over a `finished`, so it raises
      // no second notification either.
      expect(kindsSince(after)).not.toContain("session:finished");
    });

    it("is still reopened after a tool call's hook, which decided nothing", () => {
      // Review of PR 455, round 4. `PostToolUse` is installed unmatched, so
      // every ordinary tool call fires one — within milliseconds of the tool
      // completing, while this classifier reports once every five seconds, so
      // hook-then-output is the normal ordering. The pipeline writes nothing
      // for it on a row that is not `needs-input`, so it has decided nothing
      // and the recovery must survive it.
      insert("t-1", "running");
      const backstop = makeBackstop();
      settleByIdleRule(backstop);

      nowMs += 30 * 1000;
      deliverHook(backstop, { hook_event_name: "PostToolUse", tool_name: "Bash" });
      expect(statusOf("t-1")).toBe("finished");

      // The build's output lands half a minute later, and the turn is visibly
      // not over.
      nowMs += 30 * 1000;
      backstop.noteActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("running");
    });

    it("survives a reopen write that failed, and tries again", () => {
      // The marker is spent only once the write has landed: a SQLite busy
      // against the concurrent event-log writer must not cost the one chance
      // this rule has to take its own finish back (review of PR 455, round 4).
      insert("t-1", "running");
      let reopenFails = true;
      const flaky = {
        readTask: (taskId: string) => writer.readTask(taskId),
        mutate: (mutation: { op: string; status?: string }) => {
          if (reopenFails && mutation.op === "update" && mutation.status === "running") {
            throw new Error("database is locked");
          }
          return writer.mutate(mutation as never);
        },
      } as unknown as CoreTaskWriter;
      const backstop = new CoreSessionBackstop({
        listActiveTasks,
        writer: flaky,
        hasLivePty: (taskId) => livePtys.has(taskId),
        now: () => nowMs,
        quietMs: QUIET_MS,
      });
      settleByIdleRule(backstop);

      nowMs += 30 * 1000;
      backstop.noteActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("finished");

      // Five seconds later the next burst arrives, and the database is back.
      reopenFails = false;
      nowMs += 5 * 1000;
      backstop.noteActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("running");
    });

    it("never takes back a finish another writer wrote over it", () => {
      // The shape the round-3 review drove: the real terminal `Stop` lands
      // just after the idle rule settled, the pipeline writes the
      // authoritative finish — `finished` over `finished`, so the status alone
      // cannot tell them apart — and then the post-turn TUI paints its
      // composer. Only the row's `updatedAt` separates the two finishes.
      insert("t-1", "running");
      const backstop = makeBackstop();
      settleByIdleRule(backstop);

      nowMs += 30 * 1000;
      coreMutationStore.mutateTask({ op: "update", taskId: "t-1", status: "finished" });
      const after = lastEventId();

      nowMs += 30 * 1000;
      backstop.noteActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("finished");
      // No reopen, so no re-settle, so no second `session:finished` toast.
      expect(kindsSince(after)).toEqual([]);
    });

    it("is not reopened by more of the same repainting", () => {
      insert("t-1", "running");
      const backstop = makeBackstop();
      settleByIdleRule(backstop);

      paintFor(backstop, 5 * MINUTE);
      expect(statusOf("t-1")).toBe("finished");
    });

    it("never reopens a finish the quiet rule wrote", () => {
      // The marker is set by the idle rule alone. A Session that went silent
      // and was settled for it is finished, and bytes arriving later — an
      // operator scrolling the pane, a harness's parting paint — do not undo
      // an operator-visible finish.
      insert("t-1", "running");
      const backstop = makeBackstop();
      nowMs += QUIET_MS + MINUTE;
      expect(backstop.sweepOnce()).toEqual(["t-1"]);
      expect(statusOf("t-1")).toBe("finished");

      backstop.noteActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("finished");
    });

    it("leaves a row alone once someone else has moved it", () => {
      insert("t-1", "running");
      const backstop = makeBackstop();
      settleByIdleRule(backstop);

      // The operator archived it, or the PTY exit settled it. Whatever the row
      // says now, it is not this rule's `finished` any more.
      coreMutationStore.mutateTask({ op: "update", taskId: "t-1", status: "terminated" });
      backstop.noteActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("terminated");
    });

    it("stops offering to reopen once the grace has passed", () => {
      insert("t-1", "running");
      const backstop = makeBackstop();
      settleByIdleRule(backstop);

      nowMs += 31 * MINUTE;
      backstop.noteActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("finished");
    });

    it("does not reopen a Session whose process is gone", () => {
      insert("t-1", "running");
      const backstop = makeBackstop();
      settleByIdleRule(backstop);

      // The PTY exit path calls this; there are no more bytes coming, and any
      // that do arrive belong to nothing.
      backstop.forget("t-1");
      backstop.noteActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("finished");
    });
  });

  // ─── Review of PR 455, finding 2: a harness whose hooks work is not judged
  // on its pixels ───
  describe("deferring to a harness that can report itself", () => {
    /** Paint a spinner frame every second for `ms`, reporting each as a redraw. */
    const paintFor = (backstop: CoreSessionBackstop, ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
        nowMs += FRAME_MS;
        backstop.noteActivity("t-1", "redraw");
      }
    };

    it("never settles a tool call inside the deference bound", () => {
      // Claude Code installs `PreToolUse` with an `AskUserQuestion` matcher, so
      // a single `Bash` call emits no hook at all until it completes. Ten
      // minutes of `pnpm build` behind a spinner, on a harness whose hooks are
      // working, must not be called over — and the eight-minute window would
      // otherwise reach it at nine.
      insert("t-1", "running");
      const backstop = makeBackstop();

      backstop.noteActivity("t-1", "hook");
      nowMs += MINUTE;
      backstop.noteActivity("t-1", "output");
      for (let minute = 0; minute < 13; minute += 1) {
        paintFor(backstop, MINUTE);
        expect(backstop.sweepOnce()).toEqual([]);
      }
      expect(statusOf("t-1")).toBe("running");

      // And the tool completes: `PostToolUse` lands, the count of output since
      // the last hook resets, and the deference starts again from here.
      backstop.noteActivity("t-1", "hook");
      paintFor(backstop, 5 * MINUTE);
      expect(backstop.sweepOnce()).toEqual([]);
      expect(statusOf("t-1")).toBe("running");
    });

    it("settles a dropped Stop on a hooked harness, on the longer clock", () => {
      // Review of PR 455, round 2, finding 1: the deference used to last
      // forever, so the second failure #391 names — "a dropped Stop POST" —
      // was never settled at all. Four hours of spinner read `running`.
      insert("t-1", "running");
      const backstop = makeBackstop();

      backstop.noteActivity("t-1", "hook");
      nowMs += MINUTE;
      backstop.noteActivity("t-1", "output");

      // The turn ends. Its `Stop` drops. The TUI paints on.
      paintFor(backstop, 13 * MINUTE);
      expect(backstop.sweepOnce()).toEqual([]);
      expect(statusOf("t-1")).toBe("running");

      // Past the quarter-hour the deference is bounded at, the screen is the
      // only evidence left and the rule reads it — two sweeps, as ever.
      paintFor(backstop, 3 * MINUTE);
      expect(backstop.sweepOnce()).toEqual([]);
      paintFor(backstop, MINUTE);
      expect(backstop.sweepOnce()).toEqual(["t-1"]);
      expect(statusOf("t-1")).toBe("finished");

      // And a tool call that really was running for seventeen minutes takes
      // its finish back the moment it prints.
      backstop.noteActivity("t-1", "output");
      expect(statusOf("t-1")).toBe("running");
    });

    it("still settles a harness that has never sent a hook", () => {
      // Codex before `/hooks` has been reviewed: no hook has ever arrived, so
      // the screen is the only witness there is, and the rule reads it.
      insert("t-1", "running");
      const backstop = makeBackstop();
      backstop.noteActivity("t-1", "output");

      for (let second = 0; second < 10 * 60; second += 1) {
        nowMs += FRAME_MS;
        backstop.noteActivity("t-1", "redraw");
      }
      expect(backstop.sweepOnce()).toEqual([]);
      nowMs += MINUTE;
      expect(backstop.sweepOnce()).toEqual(["t-1"]);
      expect(statusOf("t-1")).toBe("finished");
    });
  });

  // The same two cases again, with the real classifier in the loop rather than
  // a hand-written `kind`: bytes in, status out. This is what the operator's
  // Codex pane actually does.
  describe("with the PTY output classifier wired in", () => {
    const idleFrame = (spinner: string, seconds: number) =>
      `\x1b[2K\x1b[G${spinner} Working (${seconds}s • Esc to interrupt)`;

    /** One second of PTY bytes, classified and reported exactly as the Core does. */
    const feed = (backstop: CoreSessionBackstop, watcher: PtyOutputActivityWatcher, chunk: string) => {
      nowMs += FRAME_MS;
      const kind = watcher.push(chunk, nowMs);
      if (kind) backstop.noteActivity("t-1", kind);
    };

    it("finishes a harness whose only output is a clock", () => {
      insert("t-1", "running");
      const backstop = makeBackstop();
      const watcher = new PtyOutputActivityWatcher();

      // The turn ended; its `Stop` dropped; the TUI is still on screen. Ten
      // minutes of it, swept once a minute the way the Core sweeps.
      const settled: string[] = [];
      for (let second = 0; second < 10 * 60; second += 1) {
        feed(backstop, watcher, idleFrame(second % 2 ? "⠹" : "⠸", second));
        if (second % 60 === 0) settled.push(...backstop.sweepOnce());
      }
      expect(settled).toEqual(["t-1"]);
      expect(statusOf("t-1")).toBe("finished");
    });

    it("leaves a turn alone while real output keeps arriving", () => {
      insert("t-1", "running");
      const backstop = makeBackstop();
      const watcher = new PtyOutputActivityWatcher();

      // Half an hour of a live turn: a spinner every second, and a tool line
      // nobody has seen before every twenty. Words, not numbers — not because
      // a number would fail (since `c0283d9` a digit only reads as a clock on
      // a line carrying a spinner glyph or an elapsed-time pattern), but so
      // this test turns on the thing it is about: new content on screen.
      const words = "resolver adapter migration checkout transcript envelope".split(" ");
      for (let second = 0; second < 30 * 60; second += 1) {
        const chunk =
          second % 20 === 0
            ? `\x1b[2K\x1b[G• Read packages/core/src/${words[(second / 20) % words.length]}-${second}.ts\r\n`
            : idleFrame(second % 2 ? "⠹" : "⠸", second);
        feed(backstop, watcher, chunk);
        if (second % 60 === 0) expect(backstop.sweepOnce()).toEqual([]);
      }
      expect(statusOf("t-1")).toBe("running");
    });
  });
});
