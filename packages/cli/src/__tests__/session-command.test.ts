// The `session` noun's surface: flags, output, exit codes (#160).
//
// The gateway is injected (`session-gateway.ts` is the only module that dials),
// so everything here runs with no Core and no socket — which is what makes it
// possible to assert the things a Core would otherwise hide: that `start`
// returns without waiting, that stdout carries the id and nothing else, that
// `--json` never shares stdout with prose, and that a flag a verb does not take
// is refused rather than ignored.
//
// `in-process-core-session.test.ts` is the other half: the same verbs against a
// real `PtyCoreLinkServer`, proving the frames are the ones a Core answers.

import { describe, it, expect, afterEach } from "vitest";
import {
  fakeSessionGateway,
  fakeStartedSession,
  makeCliFixture,
  sentinelBlobText,
  type CliFixture,
} from "./cli-harness.ts";
import { SessionGatewayError, type SessionRow } from "../session-gateway.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "../exit-codes.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** A registered Core, so resolution finds one and the verbs get as far as the gateway. */
async function withRegisteredCore(): Promise<void> {
  await cli().run(["core", "add", "prod"], { stdin: sentinelBlobText() });
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    taskId: "task_1",
    title: "fix the flaky test",
    harness: "claude-code",
    status: "running",
    projectId: "proj_1",
    project: "web",
    ptyId: "pty_1",
    live: true,
    writable: null,
    lock: null,
    updatedAt: Date.UTC(2026, 7, 12) - 3_600_000,
    ...overrides,
  };
}

describe("actana session — the command tree", () => {
  it("prints its help, and a bare `session` is a usage error", async () => {
    const help = await cli().run(["session", "--help"]);
    expect(help.code).toBe(EXIT_OK);
    expect(help.out.join("\n")).toContain("actana session start <project> [prompt]");

    const bare = await cli().run(["session"]);
    expect(bare.code).toBe(EXIT_USAGE);
  });

  it("names #163 for `attach` rather than failing as an unknown verb", async () => {
    const run = await cli().run(["session", "attach", "task_1"]);
    // The distinction `exit-codes.ts` exists to draw: reserved, not mistyped.
    expect(run.code).toBe(EXIT_UNIMPLEMENTED);
    expect(run.err.join("\n")).toContain("#163");
  });

  it("rejects an unknown verb without dialling anything", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "detach", "task_1"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain('unknown verb "detach"');
  });

  it("refuses a flag the verb does not take rather than ignoring it", async () => {
    await withRegisteredCore();
    // `--wait` on `kill` is an instruction that would otherwise be silently
    // dropped, and the operator would believe they had waited.
    const run = await cli().run(["session", "kill", "task_1", "--wait"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("--wait does not apply here");
  });

  it("says which Core it could not find when none is selected", async () => {
    const run = await cli().run(["session", "ls"], { sessions: fakeSessionGateway() });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("no Core selected");
  });
});

describe("actana session ls", () => {
  it("renders a table, and the lock column only when the Core publishes one", async () => {
    await withRegisteredCore();
    const plain = await cli().run(["session", "ls"], {
      sessions: fakeSessionGateway({ list: async () => [row()] }),
    });
    expect(plain.code, plain.err.join("\n")).toBe(EXIT_OK);
    expect(plain.out[0]).toContain("SESSION");
    expect(plain.out[0]).not.toContain("LOCK");
    expect(plain.out[1]).toContain("task_1");
    expect(plain.out[1]).toContain("fix the flaky test");
    // Relative age, from the injected clock rather than the wall clock.
    expect(plain.out[1]).toContain("1h");

    const locked = await cli().run(["session", "ls"], {
      sessions: fakeSessionGateway({
        list: async () => [row({ lock: "held-by-another", writable: false })],
      }),
    });
    expect(locked.out[0]).toContain("LOCK");
    expect(locked.out[1]).toContain("other");
  });

  it("says so when there are none, in both output modes", async () => {
    await withRegisteredCore();
    const human = await cli().run(["session", "ls"], {
      sessions: fakeSessionGateway({ list: async () => [] }),
    });
    expect(human.code).toBe(EXIT_OK);
    expect(human.out.join("\n")).toContain("No sessions");

    const json = await cli().run(["session", "ls", "--json"], {
      sessions: fakeSessionGateway({ list: async () => [] }),
    });
    expect(JSON.parse(json.out.join("\n"))).toEqual([]);
  });

  it("passes a project filter through as typed", async () => {
    await withRegisteredCore();
    let asked: string | null | undefined;
    const run = await cli().run(["session", "ls", "web"], {
      sessions: fakeSessionGateway({
        list: async (project) => {
          asked = project;
          return [];
        },
      }),
    });
    expect(run.code).toBe(EXIT_OK);
    expect(asked).toBe("web");
  });
});

describe("actana session start", () => {
  it("exits without waiting, printing the id and nothing else on stdout", async () => {
    await withRegisteredCore();
    let waited = false;
    const run = await cli().run(["session", "start", "web", "fix", "the", "tests"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => {
              waited = true;
              return { status: "finished", exited: false };
            },
          }),
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    // The one-shot default (#129 D6): the Session outlives the command.
    expect(waited).toBe(false);
    // `TASK=$(actana session start …)` is the shape of every script that will
    // use this, so stdout is the id and the progress line went to stderr.
    expect(run.out).toEqual(["task_1"]);
    expect(run.err.join("\n")).toContain("Started claude-code in web");
  });

  it("hands the prompt over as typed, and never a carriage return with it", async () => {
    await withRegisteredCore();
    let seen: Record<string, unknown> | null = null;
    await cli().run(["session", "start", "web", "fix the tests"], {
      sessions: fakeSessionGateway({
        start: async (request) => {
          seen = request as unknown as Record<string, unknown>;
          return fakeStartedSession();
        },
      }),
    });
    // Prompt delivery is the Core's (ADR 0026, #129 D3). What leaves this
    // process is text — no return, no timing, nothing appended.
    expect(seen!.prompt).toBe("fix the tests");
  });

  it("reads a prompt from stdin when it is `-`", async () => {
    await withRegisteredCore();
    let seen = "";
    await cli().run(["session", "start", "web", "-"], {
      stdin: "a prompt too long for a command line\n",
      sessions: fakeSessionGateway({
        start: async (request) => {
          seen = request.prompt ?? "";
          return fakeStartedSession();
        },
      }),
    });
    expect(seen).toBe("a prompt too long for a command line\n");
  });

  it("emits one object under --json, with no prose beside it", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "web", "go", "--json", "--verbose"], {
      sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
    });
    expect(run.code).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload).toMatchObject({ taskId: "task_1", ptyId: "pty_1", waited: false });
    // `--verbose` is the flag most likely to break the rule, so it is on here.
    expect(run.err.length).toBeGreaterThan(0);
  });

  it("blocks with --wait and reports the state the Core settled on", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "web", "go", "--wait", "--json"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => ({ status: "finished", exited: true, exitCode: 0 }),
            screen: () => "the rendered transcript",
          }),
      }),
    });
    expect(run.code).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload).toMatchObject({ waited: true, status: "finished", exited: true, exitCode: 0 });
    // The transcript rides along: the Core's replay ring dies with the PTY, so
    // a `--json` caller has no second chance at it.
    expect(payload.screen).toBe("the rendered transcript");
  });

  it("exits non-zero when the harness died, and zero when it stopped to ask", async () => {
    await withRegisteredCore();
    const died = await cli().run(["session", "start", "web", "go", "--wait"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({ wait: async () => ({ status: "terminated", exited: true, exitCode: 137 }) }),
      }),
    });
    expect(died.code).toBe(EXIT_FAILURE);

    // A question is not a failure — a script that treated it as one could not
    // then answer it with `session send`.
    const asked = await cli().run(["session", "start", "web", "go", "--wait"], {
      sessions: fakeSessionGateway({
        start: async () => fakeStartedSession({ wait: async () => ({ status: "needs-input", exited: false }) }),
      }),
    });
    expect(asked.code).toBe(EXIT_OK);
    expect(asked.err.join("\n")).toContain("needs-input");
  });

  it("passes --wait-timeout through as the SDK's deadline, and refuses it alone", async () => {
    await withRegisteredCore();
    let timeoutMs: number | undefined;
    const run = await cli().run(["session", "start", "web", "go", "--wait", "--wait-timeout", "90"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async (opts) => {
              timeoutMs = opts.timeoutMs;
              return { status: "finished", exited: false };
            },
          }),
      }),
    });
    expect(run.code).toBe(EXIT_OK);
    expect(timeoutMs).toBe(90_000);

    const alone = await cli().run(["session", "start", "web", "go", "--wait-timeout", "90"], {
      sessions: fakeSessionGateway(),
    });
    expect(alone.code).toBe(EXIT_USAGE);
    expect(alone.err.join("\n")).toContain("only means something with --wait");
  });

  it("reports a wait that ran out as this side giving up, not as a status", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "web", "go", "--wait", "--wait-timeout", "1", "--json"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => {
              throw new Error("session task_1 was still running after 1000ms");
            },
          }),
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.error).toContain("still running after");
    expect(payload.status).toBeUndefined();
  });

  it("checks the harness name before dialling", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "web", "--harness", "emacs"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("claude-code");
  });

  it("needs a project", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start"], { sessions: fakeSessionGateway() });
    expect(run.code).toBe(EXIT_USAGE);
  });
});

describe("actana session resume", () => {
  it("starts a Session on an existing conversation and reports it like `start`", async () => {
    await withRegisteredCore();
    let asked = "";
    const run = await cli().run(["session", "resume", "task_1", "carry on"], {
      sessions: fakeSessionGateway({
        resume: async (request) => {
          asked = request.taskId;
          expect(request.prompt).toBe("carry on");
          return fakeStartedSession({ command: "claude --resume abc" });
        },
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(asked).toBe("task_1");
    expect(run.out).toEqual(["task_1"]);
  });

  it("passes the gateway's reason through when there is nothing to resume", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "resume", "task_1", "--json"], {
      sessions: fakeSessionGateway({
        resume: async () => {
          throw new SessionGatewayError("nothing-to-resume", "session task_1 has no harness session id on it");
        },
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(run.out.join("\n")).error).toContain("no harness session id");
    expect(run.err.join("\n")).toContain("actana session resume:");
  });

  it("does not take --harness: the harness is a fact about the conversation", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "resume", "task_1", "--harness", "codex"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
  });
});

describe("actana session logs", () => {
  it("prints the rendered screen, and the raw bytes only when asked", async () => {
    await withRegisteredCore();
    const logs = {
      taskId: "task_1",
      ptyId: "pty_1",
      screen: "done: 3 files changed",
      raw: "[1GScanning…[1Gdone: 3 files changed",
    };
    const rendered = await cli().run(["session", "logs", "task_1"], {
      sessions: fakeSessionGateway({ logs: async () => logs }),
    });
    expect(rendered.code, rendered.err.join("\n")).toBe(EXIT_OK);
    expect(rendered.out.join("\n")).toBe("done: 3 files changed");

    const raw = await cli().run(["session", "logs", "task_1", "--raw"], {
      sessions: fakeSessionGateway({ logs: async () => logs }),
    });
    expect(raw.out.join("\n")).toContain("[1G");
  });

  it("puts the transcript in one JSON object, saying which form it is", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "logs", "task_1", "--json"], {
      sessions: fakeSessionGateway({
        logs: async () => ({ taskId: "task_1", ptyId: "pty_1", screen: "a screen", raw: "raw" }),
      }),
    });
    expect(JSON.parse(run.out.join("\n"))).toEqual({
      taskId: "task_1",
      ptyId: "pty_1",
      rendered: true,
      screen: "a screen",
    });
  });
});

describe("actana session send", () => {
  it("writes exactly what it was given, once", async () => {
    await withRegisteredCore();
    const writes: string[] = [];
    const run = await cli().run(["session", "send", "task_1", "yes", "please"], {
      sessions: fakeSessionGateway({
        send: async (_taskId, text) => {
          writes.push(text);
          return true;
        },
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    // Joined the way a shell already joined them, and nothing appended: no
    // carriage return, no second write, no timer (ADR 0026).
    expect(writes).toEqual(["yes please"]);
    expect(run.out).toEqual([]);
  });

  it("sends a carriage return as a separate write, and only with --enter", async () => {
    await withRegisteredCore();
    const writes: string[] = [];
    const run = await cli().run(["session", "send", "task_1", "2", "--enter", "--json"], {
      sessions: fakeSessionGateway({
        send: async (_taskId, text) => {
          writes.push(text);
          return true;
        },
      }),
    });
    expect(run.code).toBe(EXIT_OK);
    expect(writes).toEqual(["2", "\r"]);
    expect(JSON.parse(run.out.join("\n"))).toMatchObject({ enter: true, delivered: true });
  });

  it("fails when the Core declined the write", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "task_1", "hello"], {
      sessions: fakeSessionGateway({ send: async () => false }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("did not accept the write");
  });

  it("needs something to send", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "task_1"], { sessions: fakeSessionGateway() });
    expect(run.code).toBe(EXIT_USAGE);
  });
});

describe("actana session kill", () => {
  it("kills by session id, which is all it ever knew about the Session", async () => {
    await withRegisteredCore();
    // Nothing local is consulted: this fixture has never started a Session, and
    // the verb still works — the ticket's "killing a session the CLI did not
    // start" criterion, at the surface level.
    let asked = "";
    const run = await cli().run(["session", "kill", "task_from_the_panel"], {
      sessions: fakeSessionGateway({
        kill: async (taskId) => {
          asked = taskId;
          return { ptyId: "pty_9", killed: true };
        },
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(asked).toBe("task_from_the_panel");
    expect(run.err.join("\n")).toContain("Killed session task_from_the_panel");
  });

  it("reports a Session with nothing running as such", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "kill", "task_1", "--json"], {
      sessions: fakeSessionGateway({
        kill: async () => {
          throw new SessionGatewayError("not-running", "session task_1 has no harness running");
        },
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(run.out.join("\n")).error).toContain("no harness running");
  });
});

describe("--json means only JSON on stdout", () => {
  it("holds for every verb, on the failing path too", async () => {
    await withRegisteredCore();
    const boom = () => async () => {
      throw new SessionGatewayError("refused", "the Core refused");
    };
    const gateway = fakeSessionGateway({
      list: boom(),
      start: boom(),
      resume: boom(),
      logs: boom(),
      send: boom(),
      kill: boom(),
    });

    for (const argv of [
      ["session", "ls", "--json", "--verbose"],
      ["session", "start", "web", "go", "--json", "--verbose"],
      ["session", "resume", "task_1", "--json", "--verbose"],
      ["session", "logs", "task_1", "--json", "--verbose"],
      ["session", "send", "task_1", "hi", "--json", "--verbose"],
      ["session", "kill", "task_1", "--json", "--verbose"],
    ]) {
      const run = await cli().run(argv, { sessions: gateway });
      expect(run.code, argv.join(" ")).toBe(EXIT_FAILURE);
      const parsed = JSON.parse(run.out.join("\n"));
      expect(parsed.error, argv.join(" ")).toBe("the Core refused");
      // And the human half went where it belongs.
      expect(run.err.join("\n"), argv.join(" ")).toContain("the Core refused");
    }
  });
});
