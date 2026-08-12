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

import { describe, it, expect, afterEach } from "vitest";
import { fakeCore, makeCliFixture, sentinelBlobText, type CliFixture } from "./cli-harness.ts";
import { EXIT_OK, EXIT_USAGE } from "../exit-codes.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

async function withRegisteredCore(): Promise<void> {
  const added = await cli().run(["core", "add", "prod"], { stdin: sentinelBlobText() });
  expect(added.code).toBe(EXIT_OK);
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
    core.emitEvent({ eventId: 3, kind: "session:finished" });

    const result = await run;
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!).eventId).toBe(3);
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
