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
import {
  makeCliFixture,
  registerCore,
  type CliFixture,
} from "./cli-harness.ts";
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
    registerCore(fixture.paths, "inproc", first.blobText);

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
    registerCore(fixture.paths, "inproc", core.blobText);

    // History this operator has never asked to see.
    log.push("task:created");
    log.push("task:updated");
    log.push("session:finished");

    const firstRun: string[] = [];
    const notices: string[] = [];
    const first = fixture.run(["events", "tail", "--json", "--limit", "2", "--verbose"], {
      connect: connectCore,
      onOut: (line) => firstRun.push(line),
      onErr: (line) => notices.push(line),
    });

    // Wait for the tip hunt to have *finished*, not merely to have started.
    //
    // This is the flake in #208, and it is a race rather than a slow runner:
    // one `subscribe` is not where a first run settles. With three events
    // already in the log the Core answers the first one with a full tail and an
    // `eventsReplayed` that is only a receipt, so the run asks again from #3 and
    // waits for a second marker to close an *empty* tail (`event-tip.ts`). The
    // old wait here was `log.tailReads >= 1` — satisfied by the *first* of those
    // reads. The two events below then had a window, one round trip wide, in
    // which to land before the second `readEventTail` ran: appended inside it
    // they are history, counted by the tip tracker and deliberately never
    // printed, so `--limit 2` is never reached and the run follows a Core that
    // has nothing left to say. That is a hang, not an overrun — which is why CI
    // saw 61.7s against a 60s budget three times over, and why the file passes
    // in 1.2s whenever the race is won.
    //
    // The notice below is the run stating that it has found the end of the log
    // and switched printing on — the condition these two pushes actually need,
    // published on stderr by the command itself, and the same signal the
    // history-longer-than-a-tail test waits for. Reaching it takes a round trip
    // more under load and none of the assertions less.
    const endOfLog = (): string | undefined =>
      notices.find((line) => line.includes("the Core's log ends at #"));
    await waitFor(() => endOfLog() !== undefined, "the first tail never found the end of the log");
    // #3, and stated: the run walked the whole history and stopped at its end.
    // A tip settled anywhere else is the failure the pushes below were racing —
    // now an assertion about the cursor rather than a timeout with no evidence.
    expect(
      endOfLog(),
      "the first tail settled somewhere other than the end of the history",
    ).toContain("the Core's log ends at #3;");
    // Nothing from the tail above may be printed: with no stored cursor, a tail
    // starts at the end of the log the way `tail -f` does.
    expect(firstRun, "history was printed while the end of the log was being found").toEqual([]);

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
    registerCore(fixture.paths, "inproc", core.blobText);

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

  it("reads a history longer than one tail exactly once, in order, and then exits", async () => {
    // The printing side of the capped-tail walk (#402 review, non-blocking
    // note), against the Core that produces it. This is the mirror of the test
    // above and the one shape #205's review blocked on, now reachable on a path
    // that did not exist then: a `--limit` read re-subscribes **while printing**,
    // so a cursor moved wrong shows up here as a duplicated line or a hole,
    // neither of which throws or logs anywhere.
    //
    // 1500 events past the cursor against a cap of 1000: the first marker is a
    // receipt for a tail the Core cut short, the walk asks again from it, and
    // only an empty tail ends the read. The dedup underneath is the durable
    // client's; this is what proves it holds on this path rather than assuming
    // it does.
    const log = arrayEventLog();
    fillPastTheCap(log);
    const port = await freePort();
    const core = await coreOn(port, log);
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    // A ceiling well past the log: what ends this run is the end of the
    // history, not the count.
    const result = await fixture.run(
      ["events", "tail", "--json", "--since", "start", "--limit", "2000"],
      { connect: connectCore },
    );

    expect(result.code, result.err.join("\n")).toBe(EXIT_OK);
    const ids = idsOf(result.out);
    expect(ids).toHaveLength(1_500);
    // Each exactly once, in order. A replay storm is a repeat here; a moved
    // cursor is a gap.
    expect(ids).toEqual(Array.from({ length: 1_500 }, (_, i) => i + 1));
    // More than one read, so the cap was really hit and this exercised the walk
    // rather than a single tail that happened to fit.
    expect(log.tailReads).toBeGreaterThan(1);
  }, 60_000);

  it("prints the finish already in the log on a first --kind run, and exits", async () => {
    // #403's first criterion, against the Core that produces it and the cursor
    // file a real run writes. This is the command an operator types after a
    // session has finished, on a machine that has never followed this Core: no
    // stored cursor, no --since, and the answer already in the log. It used to
    // print nothing and never exit.
    const log = arrayEventLog();
    const port = await freePort();
    const core = await coreOn(port, log);
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    log.push("session:started");
    log.push("task:created");
    log.push("session:finished");
    log.push("task:updated");

    const result = await fixture.run(
      ["events", "tail", "--json", "--kind", "session:finished", "--limit", "1"],
      { connect: connectCore },
    );

    expect(result.code, result.err.join("\n")).toBe(EXIT_OK);
    // One event, and the one that was asked for. The three around it are the
    // history nobody asked for and are still not printed.
    expect(idsOf(result.out)).toEqual([3]);
  }, 60_000);

  it("answers a bounded first --kind run with the newest match, not the oldest", async () => {
    // Round-1 review, blocking finding 1, with the reviewer's own log. A first
    // run has no cursor, so it subscribes from #0 and its walk covers the whole
    // retained log — nothing prunes the store. A run that printed matches as
    // they went past therefore answered with the *earliest* finish the Core
    // still held: `#3`, possibly weeks old and carrying a different taskId,
    // returned with exit 0 for a question about the session that just finished
    // at `#22`. A visible hang is a better failure than a confident wrong
    // answer, which is why this is the finding that blocked the round.
    const log = arrayEventLog();
    for (let i = 0; i < 2; i += 1) log.push("task:updated"); // #1 – #2
    log.push("session:finished", '{"taskId":"t-old"}'); // #3, weeks ago
    for (let i = 0; i < 18; i += 1) log.push("task:updated"); // #4 – #21
    log.push("session:finished", '{"taskId":"t-now"}'); // #22, just watched
    for (let i = 0; i < 8; i += 1) log.push("task:updated"); // #23 – #30

    const port = await freePort();
    const core = await coreOn(port, log);
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const result = await fixture.run(
      ["events", "tail", "--json", "--kind", "session:finished", "--limit", "1"],
      { connect: connectCore },
    );

    expect(result.code, result.err.join("\n")).toBe(EXIT_OK);
    // One line, and the finish the operator actually watched happen.
    expect(idsOf(result.out)).toEqual([22]);
    expect(JSON.parse(result.out[0]!).payload).toContain("t-now");
  }, 60_000);

  it("delivers --kind matches exactly once and in order across a capped replay", async () => {
    // The case the round-1 review asked for by name, and its own numbers. The
    // Core streams at most `EVENT_TAIL_LIMIT` (1000) events per tail and closes
    // with a marker reporting the last id it *sent*, so a 1500-event log takes
    // three rounds to walk — and the ring holding the newest matches has to
    // survive every re-ask. A repeat here is a replay storm through the filter;
    // a gap is a match dropped at a round boundary.
    const log = arrayEventLog();
    for (let i = 1; i <= 1_500; i += 1) {
      log.push(i === 500 || i === 1_200 || i === 1_450 ? "session:finished" : "task:updated");
    }

    const port = await freePort();
    const core = await coreOn(port, log);
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const result = await fixture.run(
      ["events", "tail", "--json", "--kind", "session:finished", "--limit", "3"],
      { connect: connectCore },
    );

    expect(result.code, result.err.join("\n")).toBe(EXIT_OK);
    expect(idsOf(result.out)).toEqual([500, 1_200, 1_450]);
    // More than one tail read, so this really did cross the cap rather than fit
    // inside a single replay that happened to be big enough.
    expect(log.tailReads).toBeGreaterThan(1);
  }, 60_000);

  it("keeps only the newest --limit matches when the walk crosses the cap", async () => {
    // The same shape, asked a narrower question. `--limit 2` against three
    // finishes spread across three rounds is where a ring that resets per tail,
    // or one that keeps the first n it meets, gives a different and wrong
    // answer — `[500, 1200]` instead of the two most recent.
    const log = arrayEventLog();
    for (let i = 1; i <= 1_500; i += 1) {
      log.push(i === 500 || i === 1_200 || i === 1_450 ? "session:finished" : "task:updated");
    }

    const port = await freePort();
    const core = await coreOn(port, log);
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const result = await fixture.run(
      ["events", "tail", "--json", "--kind", "session:finished", "--limit", "2"],
      { connect: connectCore },
    );

    expect(result.code, result.err.join("\n")).toBe(EXIT_OK);
    expect(idsOf(result.out)).toEqual([1_200, 1_450]);
  }, 60_000);

  it("leaves the stored cursor alone when --since asks for a one-off rewind", async () => {
    const log = arrayEventLog();
    const port = await freePort();
    const core = await coreOn(port, log);
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

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
