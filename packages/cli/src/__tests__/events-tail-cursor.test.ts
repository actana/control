// `actana events tail` follows from a cursor and survives a reconnect (#161).
//
// This is the ticket's criterion, and it is not a claim a fake can support. The
// failure it guards against does not throw and does not log: a `sinceSeq` that
// is too low replays a log the operator has already read, and one that is too
// high stops live push with no error anywhere. Both look like "it worked" from
// inside the CLI. The only place they are visible is in the sequence of events
// that actually reached stdout across a connection that really dropped.
//
// So the Core here is the Core: `PtyCoreLinkServer` on a real `wss://` port,
// mTLS, a real bearer, a real event log. The drop is a real drop — the Core is
// stopped, events are appended while nothing is connected, and a second Core is
// started on the same port with the same log, which is exactly what an operator
// restarting a Core does. The CLI is not told any of this happened.

import { describe, it, expect, afterEach } from "vitest";
import { connectCore } from "../core-connection.ts";
import { cursorsDir } from "../event-cursor-file.ts";
import { EXIT_OK } from "../exit-codes.ts";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";
import {
  arrayEventLog,
  freePort,
  startInProcessCore,
  waitFor,
  type ArrayEventLog,
  type InProcessCore,
} from "./in-process-core.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

let cores: InProcessCore[] = [];
let fixture: CliFixture | null = null;

afterEach(() => {
  for (const core of cores) core.close();
  cores = [];
  fixture?.cleanup();
  fixture = null;
});

/** Start a Core on a fixed port with a given log, and remember it for teardown. */
async function coreOn(
  port: number,
  log: ArrayEventLog,
  material?: InProcessCore["material"],
): Promise<InProcessCore> {
  const core = await startInProcessCore({
    port,
    ...(material ? { material } : {}),
    eventLog: log,
    // The Core pushes live events on a poll; 25ms keeps a suite that waits on
    // three round trips honest about what it is waiting for.
    liveEventPollMs: 25,
  });
  cores.push(core);
  return core;
}

/** The event ids that reached stdout, in the order they were printed. */
function idsOf(lines: string[]): number[] {
  return lines.map((line) => (JSON.parse(line) as { eventId: number }).eventId);
}

/**
 * Fill a log past `EVENT_TAIL_LIMIT`, the cap the Core replays under.
 *
 * 1500 rather than 1001 so the second tail is a real one too: the first comes
 * back capped at 1000, the second carries 500, and only the third comes back
 * empty. A Core that has been up a day is well past this; nothing prunes the
 * store.
 */
function fillPastTheCap(log: ArrayEventLog): void {
  for (let i = 0; i < 1_500; i += 1) log.push("task:updated");
}

describe("actana events tail, across a Core restart", () => {
  it("delivers every event exactly once, in order, over a dropped connection", async () => {
    const log = arrayEventLog();
    const port = await freePort();
    const first = await coreOn(port, log);
    fixture = makeCliFixture();
    expect((await fixture.run(["core", "add", "inproc"], { stdin: first.blobText })).code).toBe(
      EXIT_OK,
    );

    const printed: string[] = [];
    const tail = fixture.run(["events", "tail", "--json", "--since", "start", "--limit", "6"], {
      connect: connectCore,
      onOut: (line) => printed.push(line),
    });

    // The subscribe has been served: from here the Core is pushing live, which
    // is the path the first three events must take.
    await waitFor(() => log.tailReads >= 1, "the tail never subscribed");
    log.push("task:created");
    log.push("task:updated");
    log.push("session:finished");
    await waitFor(() => printed.length === 3, "the first three live events never arrived");

    // The drop. Two events land while there is nothing connected to receive
    // them — the gap this whole mechanism exists to close.
    const readsBefore = log.tailReads;
    await first.stop();
    log.push("task:question");
    log.push("task:updated");

    await coreOn(port, log, first.material);
    await waitFor(() => log.tailReads > readsBefore, "the tail never re-subscribed");
    await waitFor(() => printed.length === 5, "the events missed during the drop never arrived");

    // …and live push resumes on the new connection, rather than the client
    // sitting caught-up-and-deaf behind a cursor that ran ahead of the log.
    log.push("pty:exit");

    const result = await tail;
    expect(result.code, result.err.join("\n")).toBe(EXIT_OK);

    // The assertion the ticket is about: six events, each exactly once, in
    // order. A replay storm shows up here as a repeat; a lost tail as a gap.
    expect(idsOf(result.out)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.err.join("\n")).toContain("dropped");
  }, 60_000);

  it("resumes where the last run stopped, and does not replay it", async () => {
    // The cursor's other half: a CLI is restarted constantly, so "survives a
    // reconnect" is worth little if every invocation starts from scratch.
    const log = arrayEventLog();
    const port = await freePort();
    const core = await coreOn(port, log);
    fixture = makeCliFixture();
    await fixture.run(["core", "add", "inproc"], { stdin: core.blobText });

    // History this operator has never asked to see.
    log.push("task:created");
    log.push("task:updated");
    log.push("session:finished");

    const firstRun: string[] = [];
    const first = fixture.run(["events", "tail", "--json", "--limit", "2"], {
      connect: connectCore,
      onOut: (line) => firstRun.push(line),
    });
    await waitFor(() => log.tailReads >= 1, "the first tail never subscribed");
    // Nothing from the tail above may be printed: with no stored cursor, a tail
    // starts at the end of the log the way `tail -f` does.
    log.push("task:question");
    log.push("pty:exit");

    const firstResult = await first;
    expect(idsOf(firstResult.out)).toEqual([4, 5]);

    // The cursor is on disk, under the config root the registry uses.
    const dir = cursorsDir(fixture.paths);
    expect(existsSync(dir), "no cursor was written").toBe(true);
    const [file] = readdirSync(dir);
    expect(readFileSync(path.join(dir, file!), "utf8").trim()).toBe("5");

    log.push("task:updated");

    const second = await fixture.run(["events", "tail", "--json", "--limit", "1"], {
      connect: connectCore,
    });
    // #6 and only #6: the second run replayed from the cursor rather than from
    // the beginning, and did not skip past what it had not shown.
    expect(idsOf(second.out)).toEqual([6]);
  }, 60_000);

  it("prints none of a history longer than the Core replays in one tail", async () => {
    // The defect the review of #205 blocked on, against the Core that produces
    // it. `handleSubscribe` streams at most `EVENT_TAIL_LIMIT` (1000) events and
    // then sends `eventsReplayed` carrying the last id it *sent* — so on a log
    // of 1500 the first marker says #1000, and everything from #1001 up arrives
    // afterwards through `pushLiveEvents` as ordinary events with no second
    // marker behind them. A first run that took that marker for the tip would
    // print 500 events of history: the replay storm, on the first command an
    // operator types. Nothing prunes the event log, so this is what any Core
    // that has been up a while looks like.
    const log = arrayEventLog();
    fillPastTheCap(log);
    const port = await freePort();
    const core = await coreOn(port, log);
    fixture = makeCliFixture();
    await fixture.run(["core", "add", "inproc"], { stdin: core.blobText });

    const printed: string[] = [];
    const notices: string[] = [];
    const tail = fixture.run(["events", "tail", "--json", "--limit", "1", "--verbose"], {
      connect: connectCore,
      onOut: (line) => printed.push(line),
      onErr: (line) => notices.push(line),
    });

    // Where this run decided the log ends. Waiting for the notice is also what
    // makes the push below live rather than history.
    await waitFor(
      () => notices.some((line) => line.includes("the Core's log ends at #")),
      "the tail never found the end of the log",
    );
    const end = notices.find((line) => line.includes("the Core's log ends at #"));
    // #1500 and not #1000: the first marker was a receipt for a tail the Core
    // had cut short at the cap, and a run that stopped there would follow from
    // the middle of the history — printing the 500 events above it as if they
    // had just happened.
    expect(end, "the end of the log was read off a marker the Core cut short").toContain("#1500");
    // More than one read: the cap was really hit, so this suite is exercising
    // the path it means to. One read would mean the log was short after all.
    expect(log.tailReads).toBeGreaterThan(1);
    expect(printed, "history was printed while the end of the log was being found").toEqual([]);

    log.push("session:finished");

    const result = await tail;
    expect(result.code, result.err.join("\n")).toBe(EXIT_OK);
    // One line: the event that happened after this command started following.
    // The 1500 before it were the tail it walked to get there.
    expect(idsOf(result.out)).toEqual([1501]);
  }, 60_000);

  it("leaves the stored cursor alone when --since asks for a one-off rewind", async () => {
    const log = arrayEventLog();
    const port = await freePort();
    const core = await coreOn(port, log);
    fixture = makeCliFixture();
    await fixture.run(["core", "add", "inproc"], { stdin: core.blobText });

    log.push("task:created");
    log.push("task:updated");

    const rewound = await fixture.run(
      ["events", "tail", "--json", "--since", "start", "--limit", "2"],
      { connect: connectCore },
    );
    expect(idsOf(rewound.out)).toEqual([1, 2]);

    // A rewind is a read, not a resumption: the follow-along stream is still
    // where it was, which for a Core this CLI has never followed is nowhere.
    const dir = cursorsDir(fixture.paths);
    expect(existsSync(dir) && readdirSync(dir).length > 0).toBe(false);
  }, 60_000);
});
