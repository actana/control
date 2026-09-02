// `actana events tail` — the surface (#161).
//
// The cursor itself belongs to the SDK's durable client, and
// `events-tail-cursor.test.ts` proves it against a Core that really drops. What
// this suite covers is the part that is this command's alone: where a run
// starts, what reaches stdout, and that the flags mean what the help says.
//
// The first-run claim is the one worth reading twice. A tail with no stored
// cursor asks the Core for everything — that is how the tip is learned, since no
// frame reports it — and prints none of it. A run that printed that tail would
// be the replay storm the ticket names, produced deliberately on the first
// command an operator types.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  fakeCore,
  makeCliFixture,
  registerCore,
  type CliFixture,
} from "./cli-harness.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../exit-codes.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
  vi.useRealTimers();
});

/**
 * The 30s a bounded run gives a Core that has gone quiet, jumped rather than
 * waited out. `events-command.ts` holds the constant; a test that hard-coded a
 * shorter one would be testing a different command.
 */
const SUBSCRIBE_ANSWER_MS = 30_000;

async function withRegisteredCore(): Promise<void> {
  registerCore(cli().paths, "prod");
}

/** Let the command reach the point where it is listening. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("actana events tail", () => {
  it("takes the durable client and a cursor store, not a one-shot dial", async () => {
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(["events", "tail", "--limit", "1", "--since", "start"], {
      connect: core.connect,
    });
    await settle();
    core.emitEvent({ eventId: 1, kind: "task:created" });
    await run;

    expect(core.connectOptions[0]?.durable).toBe(true);
    expect(core.connectOptions[0]?.storage).toBeDefined();
  });

  it("emits one JSON object per line, and nothing else, with --json", async () => {
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(["events", "tail", "--json", "--since", "start", "--limit", "2"], {
      connect: core.connect,
    });
    await settle();
    core.emitEvent({ eventId: 1, kind: "task:created", taskId: "t-1", payload: '{"title":"a"}' });
    core.emitEvent({ eventId: 2, kind: "pty:exit", ptyId: "p-1", payload: '{"exitCode":0}' });

    const result = await run;
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toHaveLength(2);
    // NDJSON: every line is a complete JSON value on its own, which is the only
    // shape a stream that may never end can have.
    const rows = result.out.map((line) => JSON.parse(line));
    expect(rows[0]).toEqual({
      eventId: 1,
      ts: Date.UTC(2026, 7, 12),
      kind: "task:created",
      ptyId: null,
      taskId: "t-1",
      payload: '{"title":"a"}',
    });
    expect(rows[1].kind).toBe("pty:exit");
  });

  it("prints nothing from the replay tail on a first run, then follows live", async () => {
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(["events", "tail", "--json", "--limit", "1"], { connect: core.connect });
    await settle();

    // The tail the Core streams to establish the tip. None of it is this run's
    // business — the operator asked to follow, not to read history.
    core.emitEvent({ eventId: 1, kind: "task:created" });
    core.emitEvent({ eventId: 2, kind: "task:updated" });
    core.emitReplayed(2);
    await settle();

    // A marker that closed a tail with events in it is a receipt for what was
    // sent, not a statement that the log has ended — the Core caps a replay at
    // `EVENT_TAIL_LIMIT` and reports the last id it managed. So the command
    // asks again from there, and only an empty tail ends the hunt.
    expect(core.subscribes).toContain(2);
    core.emitReplayed(2);
    await settle();

    core.emitEvent({ eventId: 3, kind: "session:finished" });

    const result = await run;
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!).eventId).toBe(3);
  });

  it("keeps printing off while a truncated replay is still being drained", async () => {
    // The blocking defect from the review of #205, at this suite's level: a
    // marker arrives, and everything after it would have been printed as if it
    // were live. Here the Core has more to give and says so by sending events
    // rather than by any flag — so a marker after a non-empty tail must not
    // start the stream, however many of them arrive.
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(["events", "tail", "--json", "--limit", "1"], { connect: core.connect });
    await settle();

    for (const round of [1, 2, 3]) {
      core.emitEvent({ eventId: round * 2 - 1, kind: "task:created" });
      core.emitEvent({ eventId: round * 2, kind: "task:updated" });
      core.emitReplayed(round * 2);
      await settle();
      // Each round is history, and each re-ask carries the cursor it reached.
      expect(core.subscribes).toContain(round * 2);
    }

    core.emitReplayed(6);
    await settle();
    core.emitEvent({ eventId: 7, kind: "session:finished" });

    const result = await run;
    // One line, and it is the only event that happened after the log's end was
    // found. Six events of history, printed never.
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!).eventId).toBe(7);
  });

  it("prints the whole tail the Core holds with --since start", async () => {
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(["events", "tail", "--since", "start", "--limit", "2"], {
      connect: core.connect,
    });
    await settle();
    core.emitEvent({ eventId: 1, kind: "task:created" });
    core.emitEvent({ eventId: 2, kind: "task:updated" });

    const result = await run;
    expect(result.out).toHaveLength(2);
    expect(result.out[0]).toContain("#1");
    expect(result.out[0]).toContain("task:created");
  });

  it("filters by --kind, repeatably", async () => {
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(
      ["events", "tail", "--json", "--since", "start", "--kind", "pty:exit", "--kind", "task:created", "--limit", "2"],
      { connect: core.connect },
    );
    await settle();
    core.emitEvent({ eventId: 1, kind: "task:created" });
    core.emitEvent({ eventId: 2, kind: "task:updated" });
    core.emitEvent({ eventId: 3, kind: "hook:fired" });
    core.emitEvent({ eventId: 4, kind: "pty:exit" });

    const result = await run;
    expect(result.out.map((line) => JSON.parse(line).eventId)).toEqual([1, 4]);
  });

  it("keeps a dropped link off stdout", async () => {
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(["events", "tail", "--json", "--since", "start", "--limit", "1"], {
      connect: core.connect,
    });
    await settle();
    core.emitDisconnected("socket hang up");
    core.emitEvent({ eventId: 1, kind: "task:created" });

    const result = await run;
    expect(result.err.join("\n")).toContain("reconnecting");
    // A consumer parsing stdout must never have to recognise a status line.
    expect(result.out).toHaveLength(1);
    JSON.parse(result.out[0]!);
  });

  // ─── #402: --limit reads history and exits ────────────────────────────────
  //
  // On live pairdemo, `events tail --since 13 --limit 30 --json` sat until it
  // was killed. The nine events past #13 were already in SQLite — the
  // `session:finished` the operator was waiting for among them — and the
  // command printed them and then waited for twenty-one more that no one was
  // ever going to append. `--limit` is a ceiling on a read of the log, not a
  // quota the command blocks on.

  it("exits from history when the log holds fewer events than --limit", async () => {
    await withRegisteredCore();
    const core = fakeCore({});

    // The pairdemo run, frame for frame: a cursor at #13, a ceiling of 30, and
    // a Core whose log ends at #22 with the finish already in it.
    const run = cli().run(["events", "tail", "--since", "13", "--limit", "30", "--json"], {
      connect: core.connect,
    });
    await settle();

    for (let eventId = 14; eventId <= 21; eventId += 1) {
      core.emitEvent({ eventId, kind: "task:updated" });
    }
    core.emitEvent({ eventId: 22, kind: "session:finished", taskId: "t-1" });
    core.emitReplayed(22);
    await settle();

    // One marker is a receipt for what was sent, not a statement that the log
    // has ended, so the run asks again from where it got to — the same
    // discipline a first run's tip hunt uses (`event-tip.ts`).
    expect(core.subscribes).toContain(22);
    core.emitReplayed(22);

    const result = await run;
    expect(result.code).toBe(EXIT_OK);
    // Nine events, not thirty, and the command is back at the prompt.
    expect(result.out).toHaveLength(9);
    const rows = result.out.map((line) => JSON.parse(line));
    expect(rows[0].eventId).toBe(14);
    expect(rows[8]).toMatchObject({ eventId: 22, kind: "session:finished" });
    expect(core.closed).toBe(true);
  });

  it("prints the history it was given when the subscribe never replays or pushes", async () => {
    // The other half of #402: the Core is contended, the subscribe answers with
    // a tail and then goes silent — no `eventsReplayed`, no live push, nothing
    // to close the loop on. The events are already here; a command that holds
    // them hostage to a marker that is not coming is the hang, reported.
    vi.useFakeTimers();
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(["events", "tail", "--since", "13", "--limit", "30", "--json"], {
      connect: core.connect,
    });
    await vi.advanceTimersByTimeAsync(0);

    for (let eventId = 14; eventId <= 22; eventId += 1) {
      core.emitEvent({ eventId, kind: eventId === 22 ? "session:finished" : "task:updated" });
    }
    // And now the Core says nothing at all, for as long as anyone is willing to
    // wait. Nobody is: the deadline is re-armed on every frame, so it runs from
    // the last thing the Core actually said.
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_ANSWER_MS);

    const result = await run;
    expect(result.code).toBe(EXIT_OK);
    expect(result.out.map((line) => JSON.parse(line).eventId)).toEqual([
      14, 15, 16, 17, 18, 19, 20, 21, 22,
    ]);
    expect(result.err.join("\n")).toContain("stopped answering");
    expect(core.closed).toBe(true);
  });

  it("does not wedge on a subscribe that answers nothing at all", async () => {
    // Nothing printed and nothing to print: the run still ends, and it ends
    // saying why rather than exiting 0 on a Core it never heard from.
    vi.useFakeTimers();
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(["events", "tail", "--since", "13", "--limit", "30", "--json"], {
      connect: core.connect,
    });
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_ANSWER_MS);

    const result = await run;
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.out).toHaveLength(0);
    expect(result.err.join("\n")).toContain("stopped answering");
    expect(core.closed).toBe(true);
  });

  it("still follows when the log had nothing past where the run started", async () => {
    // The case #402 deliberately leaves alone, and the one `events-tail-cursor`
    // is built on: a cursor with an empty log past it is what a follow looks
    // like at the moment it starts, so there is no read to finish and `--limit`
    // keeps the meaning it has always had. Ending here would end the run before
    // its first line.
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(["events", "tail", "--json", "--since", "start", "--limit", "2"], {
      connect: core.connect,
    });
    await settle();

    // Caught up, with nothing to have caught up on.
    core.emitReplayed(0);
    await settle();

    core.emitEvent({ eventId: 1, kind: "task:created" });
    core.emitEvent({ eventId: 2, kind: "session:finished" });

    const result = await run;
    expect(result.code).toBe(EXIT_OK);
    expect(result.out.map((line) => JSON.parse(line).eventId)).toEqual([1, 2]);
  });

  it("ends a read whose history matched no --kind, rather than following", async () => {
    // What decides whether there was history to read is what the Core had, not
    // what the filter let through. A read of a log that held nothing this
    // operator asked for still finished, and has nothing left to wait for —
    // reading `printed` here would hang exactly where #402 hung, one flag over.
    //
    // The first-run half of the kind filter — history skipped while the cursor
    // advances past it — is #403 and is not touched here.
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(
      ["events", "tail", "--json", "--since", "13", "--limit", "30", "--kind", "session:finished"],
      { connect: core.connect },
    );
    await settle();

    core.emitEvent({ eventId: 14, kind: "task:updated" });
    core.emitEvent({ eventId: 15, kind: "task:updated" });
    core.emitReplayed(15);
    await settle();
    core.emitReplayed(15);

    const result = await run;
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toEqual([]);
    expect(core.closed).toBe(true);
  });

  it("stops timing the Core once it has said where its log ends", async () => {
    // The deadline covers a subscribe that never answers, not a Core with
    // nothing to say. Once the end of the log is known the run is following,
    // and a follow that gave up after thirty quiet seconds would be a worse
    // hang than the one #402 fixed — silent, and on a Core behaving perfectly.
    vi.useFakeTimers();
    await withRegisteredCore();
    const core = fakeCore({});

    const run = cli().run(["events", "tail", "--json", "--since", "start", "--limit", "1"], {
      connect: core.connect,
    });
    await vi.advanceTimersByTimeAsync(0);
    core.emitReplayed(0);
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_ANSWER_MS * 3);

    // Still here, an hour of quiet later.
    let ended = false;
    void run.then(() => {
      ended = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(false);

    core.emitEvent({ eventId: 1, kind: "session:finished" });
    const result = await run;
    expect(result.code).toBe(EXIT_OK);
    expect(JSON.parse(result.out[0]!).eventId).toBe(1);
  });

  it("rejects a --since or --limit that is not a number", async () => {
    await withRegisteredCore();
    for (const argv of [
      ["events", "tail", "--since", "yesterday"],
      ["events", "tail", "--limit", "lots"],
      ["events", "tail", "--since", "-3"],
    ]) {
      const run = await cli().run(argv);
      expect(run.code, argv.join(" ")).toBe(EXIT_USAGE);
    }
  });

  it("has one verb, and says so", async () => {
    await withRegisteredCore();
    const run = await cli().run(["events", "follow"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("tail");
  });
});
