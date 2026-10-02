// The report contract on a Core that has a Shared folder (#580, review R3).
//
// This is the 0.5.0 behaviour from client issue 8 and ADR 0041, and it is intended: on a Core with a Shared
// folder `session send` appends the report block unless `--no-block`, `wait` and `send --wait` settle on
// the report file, and `--turn` and `--no-block` exist. Every other suite in this package runs the
// fallback (no Shared folder), so none of them sees any of it. These pin the contract against a Shared
// folder fixture, next to the fallback it leaves unchanged and the default deadline `send --wait` keeps.

import { describe, it, expect, afterEach } from "vitest";
import {
  fakeSessionGateway,
  fakeStartedSession,
  makeCliFixture,
  registerCore,
  type CliFixture,
} from "./cli-harness.ts";
import type { ClientDeps } from "@actana/cli";
import { EXIT_FAILURE, EXIT_OK } from "../exit-codes.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

const REPORT_1 = "sessions/session_1/report-1.md";
const REPORT_2 = "sessions/session_1/report-2.md";
const DONE = "# Done\n\nACT-REPORT-END\n";

/** A Shared folder holding `files` (path to text). `watch` reports every file as changed, once. */
function sharedFolder(files: Record<string, string>): ClientDeps["openShared"] {
  const shared = {
    watch: async () => ({
      cursor: "c1",
      changes: Object.keys(files).map((path) => ({ path, deleted: false })),
    }),
    get: async (path: string) => {
      const body = files[path];
      if (body === undefined) {
        const { CoreSharedError } = await import("@actana/sdk/shared");
        throw new CoreSharedError("not-found", `${path} is not there`);
      }
      return { body: new TextEncoder().encode(body) };
    },
    list: async (folder: string) =>
      Object.keys(files)
        .filter((path) => path.startsWith(folder))
        .map((path) => ({ kind: "file", path })),
  };
  return (async () => ({ shared, close: () => {} })) as unknown as ClientDeps["openShared"];
}

const noSharedFolder: ClientDeps["openShared"] = async () => {
  throw new Error("this Core keeps no Shared folder");
};

const knownSession = async () => [{ sessionId: "session_1" }] as never;

/** `onSend` is where a test lets the Harness answer: it writes the report the sent block asked for. */
function recordingGateway(
  sent: string[],
  deadlines: Array<number | undefined> = [],
  onSend: () => void = () => {},
) {
  return fakeSessionGateway({
    list: knownSession,
    send: async (_id, text) => {
      sent.push(text);
      onSend();
      return { ok: true } as never;
    },
    sendAndWait: async (_id, text) => {
      sent.push(text);
      return fakeStartedSession({
        wait: async (waitOpts) => {
          deadlines.push(waitOpts.timeoutMs);
          return { status: "finished", exited: false };
        },
      });
    },
  });
}

describe("session send on a Core with a Shared folder", () => {
  it("appends the report block, numbering the turn after the reports already there", async () => {
    registerCore(cli().paths, "prod");
    const sent: string[] = [];
    const run = await cli().run(["session", "send", "session_1", "carry on"], {
      sessions: recordingGateway(sent),
      openShared: sharedFolder({ [REPORT_1]: DONE }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^carry on \[Actana standard block v1\]/);
    expect(sent[0]).toContain("~/shared/sessions/session_1/report-2.md");
    expect(sent[0]).toContain("ACT-REPORT-END");
  });

  it("takes --turn for the block's turn", async () => {
    registerCore(cli().paths, "prod");
    const sent: string[] = [];
    await cli().run(["session", "send", "session_1", "again", "--turn", "7"], {
      sessions: recordingGateway(sent),
      openShared: sharedFolder({ [REPORT_1]: DONE }),
    });
    expect(sent[0]).toContain("sessions/session_1/report-7.md");
  });

  it("sends the text as given with --no-block", async () => {
    registerCore(cli().paths, "prod");
    const sent: string[] = [];
    const run = await cli().run(["session", "send", "session_1", "2", "--no-block"], {
      sessions: recordingGateway(sent),
      openShared: sharedFolder({ [REPORT_1]: DONE }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(sent).toEqual(["2"]);
  });

  it("settles send --wait on the report file, not on the Core's status", async () => {
    registerCore(cli().paths, "prod");
    const sent: string[] = [];
    const deadlines: Array<number | undefined> = [];
    const files: Record<string, string> = { [REPORT_1]: DONE };
    const run = await cli().run(["session", "send", "session_1", "go on", "--wait", "--json"], {
      sessions: recordingGateway(sent, deadlines, () => {
        files[REPORT_2] = "# answer\n\nACT-REPORT-END\n";
      }),
      openShared: sharedFolder(files),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    // The status wait was never asked: no attached session was waited on.
    expect(deadlines).toEqual([]);
    const result = JSON.parse(run.out.join("\n")) as { turn: number; report: string; settled: boolean };
    expect(result).toMatchObject({ turn: 2, settled: true, report: expect.stringContaining("# answer") });
    expect(sent[0]).toContain("report-2.md");
  });

  it("settles wait on the latest report there is, or the one --turn names", async () => {
    registerCore(cli().paths, "prod");
    const sessions = fakeSessionGateway({ list: knownSession });
    const files = { [REPORT_1]: "# one\n\nACT-REPORT-END\n", [REPORT_2]: "# two\n\nACT-REPORT-END\n" };
    const latest = await cli().run(["session", "wait", "session_1", "--json"], {
      sessions,
      openShared: sharedFolder(files),
    });
    expect(latest.code, latest.err.join("\n")).toBe(EXIT_OK);
    expect(JSON.parse(latest.out.join("\n"))).toMatchObject({ turn: 2, report: expect.stringContaining("# two") });
    const first = await cli().run(["session", "wait", "session_1", "--turn", "1", "--json"], {
      sessions,
      openShared: sharedFolder(files),
    });
    expect(JSON.parse(first.out.join("\n"))).toMatchObject({ turn: 1, report: expect.stringContaining("# one") });
  });

  it("gives up on a report that never lands at --wait-timeout, naming the file", async () => {
    registerCore(cli().paths, "prod");
    const run = await cli().run(
      ["session", "wait", "session_1", "--turn", "4", "--wait-timeout", "0.05"],
      { sessions: fakeSessionGateway({ list: knownSession }), openShared: sharedFolder({ [REPORT_1]: DONE }) },
    );
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("sessions/session_1/report-4.md");
  });
});

describe("without a Shared folder, nothing of that applies", () => {
  it("sends the text as given and says no block was appended", async () => {
    registerCore(cli().paths, "prod");
    const sent: string[] = [];
    const run = await cli().run(["session", "send", "session_1", "carry on"], {
      sessions: recordingGateway(sent),
      openShared: noSharedFolder,
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(sent).toEqual(["carry on"]);
    expect(run.err.join("\n")).toContain("no report block was appended");
  });

  it("falls back to the status wait, and refuses --turn there", async () => {
    registerCore(cli().paths, "prod");
    const sent: string[] = [];
    const deadlines: Array<number | undefined> = [];
    const run = await cli().run(["session", "send", "session_1", "go on", "--wait"], {
      sessions: recordingGateway(sent, deadlines),
      openShared: noSharedFolder,
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(run.err.join("\n")).toContain("the status-based wait was used");
    expect(deadlines).toHaveLength(1);
    const turned = await cli().run(["session", "send", "session_1", "go on", "--wait", "--turn", "2"], {
      sessions: recordingGateway([]),
      openShared: noSharedFolder,
    });
    expect(turned.code).toBe(EXIT_FAILURE);
    expect(turned.err.join("\n")).toContain("--turn names a report file");
  });
});

describe("the default deadline of send --wait", () => {
  it("is 1020 seconds on the status wait, and --wait-timeout 0 removes it", async () => {
    registerCore(cli().paths, "prod");
    const deadlines: Array<number | undefined> = [];
    await cli().run(["session", "send", "session_1", "go on", "--wait"], {
      sessions: recordingGateway([], deadlines),
      openShared: noSharedFolder,
    });
    await cli().run(["session", "send", "session_1", "go on", "--wait", "--wait-timeout", "0"], {
      sessions: recordingGateway([], deadlines),
      openShared: noSharedFolder,
    });
    expect(deadlines).toEqual([1_020_000, undefined]);
  });
});
