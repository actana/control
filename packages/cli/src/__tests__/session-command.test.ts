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
  registerCore,
  type CliFixture,
} from "./cli-harness.ts";
import {
  SessionGatewayError,
  type SessionRow,
  type StartedSession,
} from "../session-gateway.ts";
import {
  CoreSessionLinkLostError,
  CoreSessionTurnTimeoutError,
} from "@actana/sdk/core-session.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../exit-codes.ts";

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
  registerCore(cli().paths, "prod");
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

  it("refuses `attach` from something that is not a terminal, rather than half-doing it", async () => {
    // The fixture's default terminal is not a TTY, which is what a pipe or a CI
    // job gets. `attach` is raw mode and keystrokes; there is nothing partial it
    // could usefully do there, and it dials nothing to say so — the fixture
    // throws on `openAttach`, so a run that reached the wire would fail here.
    await withRegisteredCore();
    const run = await cli().run(["session", "attach", "task_1"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("not a terminal");
    // And it points at the two verbs that *do* work from a script.
    expect(run.err.join("\n")).toContain("session logs");
    expect(run.err.join("\n")).toContain("session send");
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

  // ─── The turn-start asymmetry (issue 177 finding 4) ────────────────────
  //
  // Over the CLI a cursor-cli Session is statusless from prompt to stop:
  // cursor-agent takes the Core's `.cursor/hooks.json` and never fires
  // `beforeSubmitPrompt`, so nothing moves the row to `running`. The Panel
  // compensates by watching the keystrokes going into its pane; `start` hands
  // the prompt over and hangs up, so it has no keystrokes to watch. What it
  // can do is say so, which is the half of the acceptance criterion a CLI can
  // honestly meet.

  it("says plainly when nothing will report the start of a turn", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "web", "go", "--harness", "cursor-cli"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({ harness: "cursor-cli", reportsTurnStart: false }),
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    const err = run.err.join("\n");
    expect(err).toContain("does not report the start of a turn");
    expect(err).toContain("cursor-cli");
    // Named so an operator does not read the caveat as "this session is
    // broken" — the two things that still work are the two they would reach
    // for next.
    expect(err).toContain("--wait");
    expect(err).toContain("session logs");
    // Still just the id on stdout: a caveat is not output a script captures.
    expect(run.out).toEqual(["task_1"]);
  });

  it("says nothing about turn starts for a harness that reports them", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "web", "go"], {
      sessions: fakeSessionGateway({
        start: async () => fakeStartedSession({ reportsTurnStart: true }),
      }),
    });
    expect(run.err.join("\n")).not.toContain("does not report the start of a turn");
  });

  it("carries the answer as a --json field, not only as prose", async () => {
    // A script deciding whether a quiet status means "still working" or "never
    // started" cannot parse a sentence off stderr.
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "web", "go", "--json"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({ harness: "cursor-cli", reportsTurnStart: false }),
      }),
    });
    expect(JSON.parse(run.out.join("\n"))).toMatchObject({ reportsTurnStart: false });
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

  it("says the prompt did not land, and exits non-zero, when the Core abandoned it", async () => {
    // Issue 483. The status a lost prompt produces is `needs-input`, which the
    // test above proves is a zero exit on purpose — a harness that stopped to
    // ask a question did not fail. A harness that never received the prompt
    // did, and reporting it the same way is the false success the issue is
    // about: after #387 settles a stranded `ready` Session, this presents as a
    // settled Session that produced no report and nothing else.
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "web", "go", "--wait"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => ({ status: "needs-input", exited: false }),
            promptAbandoned: () => ({
              reason: "opencode composer never appeared within 90000 ms",
            }),
          }),
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    expect(err).toContain("did not deliver the starting prompt");
    expect(err).toContain("opencode composer never appeared within 90000 ms");
    // And it says what to do about it, which is not what `needs-input` implies.
    expect(err).toContain("session send");
  });

  it("puts the delivery on the --json object as a field, not only in prose", async () => {
    await withRegisteredCore();
    const lost = await cli().run(["session", "start", "web", "go", "--wait", "--json"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => ({ status: "needs-input", exited: false }),
            promptAbandoned: () => ({ reason: "blocked by folder-trust" }),
          }),
      }),
    });
    expect(lost.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(lost.out.join("\n"))).toMatchObject({
      status: "needs-input",
      promptDelivered: false,
      promptAbandonedReason: "blocked by folder-trust",
    });

    // The ordinary case says so too, so a script reads one field either way
    // rather than testing for a key's absence.
    const landed = await cli().run(["session", "start", "web", "go", "--wait", "--json"], {
      sessions: fakeSessionGateway({ start: async () => fakeStartedSession() }),
    });
    const payload = JSON.parse(landed.out.join("\n"));
    expect(payload.promptDelivered).toBe(true);
    expect(payload.promptAbandonedReason).toBeUndefined();
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

describe("actana session wait, and send --wait (#289)", () => {
  /** An attached Session, settling on whatever the test says. */
  function attached(overrides: Partial<StartedSession> = {}): StartedSession {
    return fakeStartedSession({
      // The three answers only a spawn gives. An attach did not spawn.
      command: null,
      reportsTurnStart: null,
      ...overrides,
    });
  }

  it("is a verb of its own, and takes --wait-timeout without a --wait beside it", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "wait", "task_1", "--wait-timeout", "90"], {
      sessions: fakeSessionGateway({
        wait: async () => attached({ wait: async () => ({ status: "finished", exited: false }) }),
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    // The id on stdout, as every other verb leaves it, so `$(…)` still works.
    expect(run.out).toEqual(["task_1"]);
    expect(run.err.join("\n")).toContain("finished");
  });

  it("refuses the flags it does not take, `--wait` included", async () => {
    await withRegisteredCore();
    for (const flag of ["--wait", "--enter", "--harness", "--raw"]) {
      const argv = flag === "--harness" ? ["--harness", "codex"] : [flag];
      const run = await cli().run(["session", "wait", "task_1", ...argv], {
        sessions: fakeSessionGateway(),
      });
      // `--wait` is refused rather than accepted as a synonym for the verb's
      // own name: a flag that means nothing here would be a flag somebody
      // believed they set.
      expect(run.code, `${flag} was not refused`).toBe(EXIT_USAGE);
      expect(run.err.join("\n")).toContain(`${flag} does not apply here`);
    }
  });

  it("needs a session id, and refuses a second argument", async () => {
    await withRegisteredCore();
    const bare = await cli().run(["session", "wait"], { sessions: fakeSessionGateway() });
    expect(bare.code).toBe(EXIT_USAGE);
    expect(bare.err.join("\n")).toContain("a session id is required");

    const extra = await cli().run(["session", "wait", "task_1", "task_2"], {
      sessions: fakeSessionGateway(),
    });
    expect(extra.code).toBe(EXIT_USAGE);
    expect(extra.err.join("\n")).toContain('unexpected argument "task_2"');
  });

  it("says a Session with no harness running has nothing to wait on", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "wait", "task_1"], {
      sessions: fakeSessionGateway({
        wait: async () => {
          throw new SessionGatewayError(
            "not-running",
            "session task_1 has no harness running — there is nothing to attach a wait to",
          );
        },
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("no harness running");
  });

  it("accepts `send --wait`, which was a usage error", async () => {
    await withRegisteredCore();
    const sent: Array<{ text: string; enter: boolean | undefined }> = [];
    const run = await cli().run(["session", "send", "task_1", "carry", "on", "--wait"], {
      sessions: fakeSessionGateway({
        sendAndWait: async (_taskId, text, opts) => {
          sent.push({ text, enter: opts?.enter });
          return attached({ wait: async () => ({ status: "needs-input", exited: false }) });
        },
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    // One call for the write and the wait — the gateway resolves the PTY once
    // and there is no window between the delivery and the start of the wait.
    // `enter: true` since #404: the write a `--wait` waits for is one that
    // submits, because a turn nothing started never ends.
    expect(sent).toEqual([{ text: "carry on", enter: true }]);
    expect(run.err.join("\n")).toContain("Sent 8 characters");
    expect(run.err.join("\n")).toContain("needs-input");
  });

  it("prints the same object `start --wait --json` prints", async () => {
    await withRegisteredCore();
    const outcome = { status: "finished", exited: true, exitCode: 0 };

    const started = await cli().run(["session", "start", "web", "go", "--wait", "--json"], {
      sessions: fakeSessionGateway({
        start: async () => fakeStartedSession({ wait: async () => outcome }),
      }),
    });
    const sent = await cli().run(["session", "send", "task_1", "go on", "--wait", "--json"], {
      sessions: fakeSessionGateway({
        sendAndWait: async () => attached({ wait: async () => outcome }),
      }),
    });
    const waited = await cli().run(["session", "wait", "task_1", "--json"], {
      sessions: fakeSessionGateway({ wait: async () => attached({ wait: async () => outcome }) }),
    });

    expect(started.code, started.err.join("\n")).toBe(EXIT_OK);
    expect(sent.code, sent.err.join("\n")).toBe(EXIT_OK);
    expect(waited.code, waited.err.join("\n")).toBe(EXIT_OK);

    const keys = (run: { out: string[] }) =>
      Object.keys(JSON.parse(run.out.join("\n")) as Record<string, unknown>).sort();
    // One result shape across the three commands, so a caller's parser does not
    // fork on which verb produced the document.
    expect(keys(sent)).toEqual(keys(started));
    expect(keys(waited)).toEqual(keys(started));
    expect(keys(started)).toContain("screen");
    expect(keys(started)).toContain("waited");

    // And the fields an attach cannot answer are `null` rather than invented.
    const attachedDoc = JSON.parse(sent.out.join("\n")) as Record<string, unknown>;
    expect(attachedDoc.command).toBeNull();
    expect(attachedDoc.reportsTurnStart).toBeNull();
  });

  it("reports a timeout as this side giving up, never as a status", async () => {
    await withRegisteredCore();
    const run = await cli().run(
      ["session", "send", "task_1", "go on", "--wait", "--wait-timeout", "1", "--json"],
      {
        sessions: fakeSessionGateway({
          sendAndWait: async () =>
            attached({
              wait: async () => {
                throw new Error("session task_1 was still running after 1000ms");
              },
            }),
        }),
      },
    );
    // The existing failure code, not a new one: `exit-codes.ts` belongs to #285
    // and a wait timeout has always been `EXIT_FAILURE` for `start --wait`.
    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
    expect(payload.waited).toBe(true);
    expect(payload.error).toContain("was still running");
    expect(payload.status).toBeUndefined();
  });

  it("refuses --wait-timeout on a send that is not waiting", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "task_1", "go", "--wait-timeout", "90"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("only means something with --wait");
  });

  it("states the running-turn limit in the help text", async () => {
    // #289 C: a keystroke into a busy harness is not a new turn, so a send into
    // one resolves on *that* turn's end — possibly before the harness has read
    // the text. It is stated rather than left to be discovered.
    const help = await cli().run(["session", "--help"]);
    expect(help.out.join("\n")).toContain("actana session wait <session>");
    expect(help.out.join("\n")).toContain("resolves on that turn's end");
    expect(help.out.join("\n")).toContain("this side gave up");
  });
});

describe("actana session send", () => {
  /** Record what the verb asked the gateway to write, in one place. */
  function recordingGateway(calls: Array<{ text: string; enter: boolean | undefined }>) {
    return fakeSessionGateway({
      send: async (_taskId, text, opts) => {
        calls.push({ text, enter: opts?.enter });
        return { ok: true };
      },
    });
  }

  it("writes exactly what it was given, and submits it (#404)", async () => {
    await withRegisteredCore();
    const calls: Array<{ text: string; enter: boolean | undefined }> = [];
    const run = await cli().run(["session", "send", "task_1", "yes", "please"], {
      sessions: recordingGateway(calls),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    // Joined the way a shell already joined them, unaltered — and the return
    // asked for, because a send is a message. That the return is its own write
    // rather than glued to the text is asserted against a real Core in
    // `in-process-core-session.test.ts`.
    expect(calls).toEqual([{ text: "yes please", enter: true }]);
    expect(run.out).toEqual([]);
    expect(run.err.join("\n")).toContain("and a carriage return");
  });

  it("types without submitting under --no-enter, and says so on the way out (#404)", async () => {
    await withRegisteredCore();
    const calls: Array<{ text: string; enter: boolean | undefined }> = [];
    const run = await cli().run(["session", "send", "task_1", "continue", "--no-enter"], {
      sessions: recordingGateway(calls),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(calls).toEqual([{ text: "continue", enter: false }]);
    // The exit path is the other half of the acceptance: a send that started no
    // turn is allowed and is never quiet about it.
    const err = run.err.join("\n");
    expect(err).toContain("no carriage return followed the text");
    expect(err).toContain("started no turn");
    expect(err).toContain("actana session send task_1 --enter");
  });

  it("still accepts --enter, which now asks for what already happens (#404)", async () => {
    await withRegisteredCore();
    const calls: Array<{ text: string; enter: boolean | undefined }> = [];
    const run = await cli().run(["session", "send", "task_1", "2", "--enter", "--json"], {
      sessions: recordingGateway(calls),
    });
    expect(run.code).toBe(EXIT_OK);
    // One call, not two: the gateway resolves the PTY once and writes both, so
    // there is no window in which the text lands and the return goes nowhere.
    expect(calls).toEqual([{ text: "2", enter: true }]);
    expect(JSON.parse(run.out.join("\n"))).toMatchObject({
      enter: true,
      submitted: true,
      delivered: true,
    });
    // The flag changed nothing: the same command line without it writes the
    // same two things.
    const without: Array<{ text: string; enter: boolean | undefined }> = [];
    const bare = await cli().run(["session", "send", "task_1", "2", "--json"], {
      sessions: recordingGateway(without),
    });
    expect(bare.code).toBe(EXIT_OK);
    expect(without).toEqual(calls);
  });

  it("reports the missing submission in --json as well, on both streams", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "task_1", "2", "--no-enter", "--json"], {
      sessions: fakeSessionGateway({ send: async () => ({ ok: true }) }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    // The document keeps the `--json` rule — only JSON on stdout — and carries
    // the fact, so a script never has to read prose to learn no turn started.
    expect(JSON.parse(run.out.join("\n"))).toMatchObject({ enter: false, submitted: false });
    expect(run.err.join("\n")).toContain("started no turn");
  });

  it("refuses --enter and --no-enter together rather than picking one", async () => {
    await withRegisteredCore();
    // Nothing is dialled: the fixture's gateway would throw if it were, which is
    // the assertion that a contradiction is caught before a byte is written.
    const run = await cli().run(["session", "send", "task_1", "2", "--enter", "--no-enter"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("contradict each other");
  });

  it("submits a follow-up sent with --wait, and bounds the wait it did not start", async () => {
    await withRegisteredCore();
    const calls: Array<{ text: string; enter: boolean | undefined }> = [];
    const deadlines: Array<number | undefined> = [];
    const outcome = { status: "finished", exited: true, exitCode: 0 } as const;
    const run = await cli().run(["session", "send", "task_1", "carry on", "--wait"], {
      sessions: fakeSessionGateway({
        sendAndWait: async (_taskId, text, opts) => {
          calls.push({ text, enter: opts?.enter });
          return fakeStartedSession({
            wait: async (waitOpts) => {
              deadlines.push(waitOpts.timeoutMs);
              return outcome;
            },
          });
        },
      }),
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    // The wait path takes the same default the plain path does, so the turn it
    // waits for is one that actually starts.
    expect(calls).toEqual([{ text: "carry on", enter: true }]);
    // And it carries a deadline the operator did not have to know to ask for
    // (#405): the return can land on a dialog rather than a composer, in which
    // case no turn starts and nothing will ever end this wait. Seventeen
    // minutes, which is past the Core's own fifteen-minute quiet backstop and
    // the minute its sweep can add — where the Core has an answer it gets to
    // give it, and this only fires where it has none.
    expect(deadlines).toEqual([1_020_000]);
  });

  it("refuses --no-enter with --wait rather than waiting for a turn it did not start", async () => {
    await withRegisteredCore();
    // #405, the first acceptance criterion. Nothing is dialled — the fixture's
    // gateway throws if it is — so the refusal lands before a byte is written,
    // which is what makes it a usage error rather than a failed send.
    const run = await cli().run(["session", "send", "task_1", "carry on", "--no-enter", "--wait"], {
      sessions: fakeSessionGateway(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("--no-enter starts no turn");
    // It names both ways out, because an operator who typed this wanted one of
    // them: submit and wait, or type now and wait separately.
    expect(run.err.join("\n")).toContain("actana session wait");
  });

  it("lets --wait-timeout replace the send deadline, and 0 remove it", async () => {
    await withRegisteredCore();
    const deadlines: Array<number | undefined> = [];
    const gateway = () =>
      fakeSessionGateway({
        sendAndWait: async () =>
          fakeStartedSession({
            wait: async (waitOpts) => {
              deadlines.push(waitOpts.timeoutMs);
              return { status: "finished", exited: false };
            },
          }),
      });

    const bounded = await cli().run(
      ["session", "send", "task_1", "carry on", "--wait", "--wait-timeout", "30"],
      { sessions: gateway() },
    );
    expect(bounded.code, bounded.err.join("\n")).toBe(EXIT_OK);

    // `0` is the opt-out, spelled out: the old unbounded wait, for a caller that
    // knows its turn is long and would rather hang than be given up on.
    const unbounded = await cli().run(
      ["session", "send", "task_1", "carry on", "--wait", "--wait-timeout", "0"],
      { sessions: gateway() },
    );
    expect(unbounded.code, unbounded.err.join("\n")).toBe(EXIT_OK);

    expect(deadlines).toEqual([30_000, undefined]);
  });

  it("takes --wait-timeout 0 as no deadline on the other verbs that accept it", async () => {
    await withRegisteredCore();
    // The "one spelling, one meaning" claim rested on the shared parser alone
    // (#486 review, coverage). Asserted here on the two other verbs a `0` can
    // reach: they had no default to opt out of, so `0` must be accepted and
    // must mean the same thing rather than being refused as it once was.
    const deadlines: Array<number | undefined> = [];
    const settle = () =>
      fakeStartedSession({
        wait: async (waitOpts) => {
          deadlines.push(waitOpts.timeoutMs);
          return { status: "finished", exited: false };
        },
      });

    const started = await cli().run(["session", "start", "web", "go", "--wait", "--wait-timeout", "0"], {
      sessions: fakeSessionGateway({ start: async () => settle() }),
    });
    expect(started.code, started.err.join("\n")).toBe(EXIT_OK);

    const waited = await cli().run(["session", "wait", "task_1", "--wait-timeout", "0"], {
      sessions: fakeSessionGateway({ wait: async () => settle() }),
    });
    expect(waited.code, waited.err.join("\n")).toBe(EXIT_OK);

    expect(deadlines).toEqual([undefined, undefined]);

    // And the discontinuity stops at zero: a negative is still a refusal, and a
    // positive that rounds below a millisecond is still a deadline rather than
    // an unbounded wait.
    const negative = await cli().run(["session", "wait", "task_1", "--wait-timeout", "-1"], {
      sessions: fakeSessionGateway(),
    });
    expect(negative.code).toBe(EXIT_USAGE);
    expect(negative.err.join("\n")).toContain("wants a number of seconds");

    const tiny: Array<number | undefined> = [];
    const rounded = await cli().run(["session", "wait", "task_1", "--wait-timeout", "0.0001"], {
      sessions: fakeSessionGateway({
        wait: async () =>
          fakeStartedSession({
            wait: async (waitOpts) => {
              tiny.push(waitOpts.timeoutMs);
              return { status: "finished", exited: false };
            },
          }),
      }),
    });
    expect(rounded.code, rounded.err.join("\n")).toBe(EXIT_OK);
    expect(tiny).toEqual([1]);
  });

  it("reports a send wait that heard nothing as this side giving up", async () => {
    await withRegisteredCore();
    // The dialog case, end to end: the SDK's deadline expires having heard no
    // status since the delivery, and what reaches the operator is that message
    // — with the exit code that says the wait did not succeed, and no status
    // the Core never sent.
    const run = await cli().run(["session", "send", "task_1", "carry on", "--wait", "--json"], {
      sessions: fakeSessionGateway({
        sendAndWait: async () =>
          fakeStartedSession({
            wait: async () => {
              throw new CoreSessionTurnTimeoutError({
                taskId: "task_1",
                timeoutMs: 900_000,
                afterEventId: 42,
                lastStatus: "needs-input",
                reportedSinceDelivery: false,
              });
            },
          }),
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.waited).toBe(true);
    expect(payload.status).toBeUndefined();
    // The message names both readings rather than diagnosing one: a return that
    // submitted nothing, or a harness that reports nothing until a turn ends.
    expect(payload.error).toContain("lands on a dialog rather than a composer");
    expect(payload.error).toContain("still running on a harness that reports nothing");
    expect(run.err.join("\n")).toContain("no turn end was reported");
    // The next step is the CLI's to name, and it is named only on this shape of
    // timeout: read the screen, or follow the log **from the delivery**.
    expect(run.err.join("\n")).toContain("`actana session logs task_1` shows what is on screen");
    expect(run.err.join("\n")).toContain("`actana events tail --since 42`");
    // **And it warns off `session wait`.** That verb is uncursored: in this
    // exact state it answers at once with the status from before the send and
    // exits zero, which reads as a completed turn. Recommending it would put
    // #405's false completion back one layer up.
    expect(run.err.join("\n")).toContain("Not `session wait`");
    expect(run.err.join("\n")).toContain("exits zero");
  });

  it("exits non-zero when the link drops mid-wait, and calls the outcome unknown (#396)", async () => {
    // Issue #396's acceptance criterion, at the layer the operator meets it:
    // `--wait` against a Core that blips used to leave the command pending for
    // ever. It now ends — non-zero, with the outcome named as unknown, and
    // **not** as a status the Core never sent.
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "task_1", "carry on", "--wait", "--json"], {
      sessions: fakeSessionGateway({
        sendAndWait: async () =>
          fakeStartedSession({
            wait: async () => {
              throw new CoreSessionLinkLostError({
                taskId: "task_1",
                afterEventId: 42,
                lastStatus: "running",
                reportedSinceDelivery: true,
                graceMs: 30_000,
                reason: "socket hang up",
              });
            },
          }),
      }),
    });

    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.waited).toBe(true);
    // No status key at all: the Core reported none, so the document carries
    // none. A `--json` caller branching on `status` must not find `running`
    // here and read it as the turn.
    expect(payload.status).toBeUndefined();
    expect(payload.error).toContain("outcome is unknown");
    expect(payload.error).toContain("not a report that the turn finished");
    expect(run.err.join("\n")).toContain("the turn's outcome is unknown");
    // Cursored, so the next step is the log from the delivery — and, as after
    // #405's timeout, explicitly not `session wait`, which would answer from the
    // status this Session was parked at before the drop and exit zero.
    expect(run.err.join("\n")).toContain("`actana events tail --since 42`");
    expect(run.err.join("\n")).toContain("Not `session wait`");
  });

  it("points an uncursored wait at the Core rather than at a delivery it never made", async () => {
    // `start --wait` and `session wait` carry no delivery stamp, so there is no
    // `--since` to follow and the advice that names one would be a fiction.
    await withRegisteredCore();
    const run = await cli().run(["session", "start", "web", "go", "--wait"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => {
              throw new CoreSessionLinkLostError({
                taskId: "task_1",
                afterEventId: 0,
                lastStatus: null,
                reportedSinceDelivery: false,
                graceMs: 0,
                reason: null,
              });
            },
          }),
      }),
    });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("the turn's outcome is unknown");
    expect(run.err.join("\n")).toContain("`actana session ls`");
    expect(run.err.join("\n")).not.toContain("events tail --since");
  });

  it("does not offer the uncursored wait as the next step after any timeout", async () => {
    await withRegisteredCore();
    // #486 review, the blocking finding. `start --wait` waits uncursored, so its
    // timeout carries `afterEventId: 0` and the generic wording — the
    // write-specific advice must not be appended under it, and the `session
    // wait` warning has nothing to warn about there.
    const started = await cli().run(["session", "start", "web", "go", "--wait", "--wait-timeout", "1"], {
      sessions: fakeSessionGateway({
        start: async () =>
          fakeStartedSession({
            wait: async () => {
              throw new CoreSessionTurnTimeoutError({
                taskId: "task_1",
                timeoutMs: 1000,
                afterEventId: 0,
                lastStatus: "running",
                reportedSinceDelivery: false,
              });
            },
          }),
      }),
    });
    expect(started.code).toBe(EXIT_FAILURE);
    expect(started.err.join("\n")).toContain("was still running after 1000ms");
    expect(started.err.join("\n")).not.toContain("events tail --since");
    expect(started.err.join("\n")).not.toContain("no turn end was reported");
  });

  it("keeps the help's next step off `session wait` too", async () => {
    const help = await cli().run(["session", "--help"]);
    const text = help.out.join("\n");
    // The prose and the runtime message have to agree, because an operator
    // reads whichever they reach first.
    expect(text).toContain("`wait` is not how you resume that wait");
    expect(text).toContain("returns at once with the status from *before* your text and exits zero");
    expect(text).toContain("actana events tail --since <event id>");
  });

  it("says in its help what submits, what does not, and what each is not", async () => {
    const help = await cli().run(["session", "--help"]);
    const text = help.out.join("\n");
    expect(text).toContain("--no-enter");
    expect(text).toContain("This starts no turn");
    // The four statements the review of #462 found untrue, each pinned to the
    // wording that replaced it, so none of them can drift back in.
    //
    // 1. `--enter` is not a blanket no-op: with no text it is the whole message.
    expect(text).toContain("only meaningful with no text");
    // 2. A separate write is necessary and not sufficient — ADR 0026 saw a
    //    separate return absorbed anyway, and the gate that answers that is the
    //    Core's, not this path's.
    expect(text).toContain("Separate is necessary and not sufficient");
    expect(text).toContain("150 ms later, absorbed anyway");
    // 3. `--wait` after `--no-enter` was the hang and the lie #405 is about,
    //    and the help now says the pair is refused rather than describing what
    //    it does to you.
    expect(text).toContain("It cannot be combined with");
    expect(text).toContain("refused before anything is written (#405)");
    // ...and the deadline that verb carries, which is the other half of #405:
    // a return that lands on a dialog starts no turn, so an unbounded default
    // there is a wait nothing can end.
    expect(text).toContain("`send --wait` is the exception");
    expect(text).toContain("`--wait-timeout 0` waits with no\n  deadline");
    // 4. `submitted` is on the plain document only, never the wait's (#289).
    expect(text).toContain("**not** on the `--wait` document");
  });

  it("does not contradict itself 37 lines later (#462 review round 2)", async () => {
    const help = await cli().run(["session", "--help"]);
    const text = help.out.join("\n");
    // `SESSION_HELP` is printed whole, so its closing summary is read in the
    // same breath as the section above it. It used to end "`send` writes exactly
    // what it is given", which stopped being true the moment the return became
    // the default — the same class of defect as round 1's four.
    expect(text).not.toContain("writes exactly what it is given");
    // What survives is the distinction the rest of the diff keeps: no *timing*
    // from this side, and a return that goes because the flags asked for one.
    expect(text).toContain("This CLI adds no timing of its own");
    expect(text).toContain("adds nothing but the carriage return the flags above asked for");
    expect(text).toContain("A lost prompt\n  is a Core bug.");
  });

  it("refuses empty stdin rather than reporting a delivery it never made", async () => {
    await withRegisteredCore();
    // The Core is never reached, so the fixture's gateway would throw if it
    // were — which is the assertion: nothing claimed a write it did not do.
    const run = await cli().run(["session", "send", "task_1", "-"], {
      sessions: fakeSessionGateway(),
      stdin: "",
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("stdin was empty");
  });

  it("still sends a bare carriage return when stdin is empty and --enter was asked for", async () => {
    await withRegisteredCore();
    const calls: Array<{ text: string; enter: boolean | undefined }> = [];
    const run = await cli().run(["session", "send", "task_1", "-", "--enter"], {
      sessions: fakeSessionGateway({
        send: async (_taskId, text, opts) => {
          calls.push({ text, enter: opts?.enter });
          return { ok: true };
        },
      }),
      stdin: "",
    });
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(calls).toEqual([{ text: "", enter: true }]);
  });

  it("fails when the Core declined the text, and says a resend is safe", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "send", "task_1", "hello"], {
      sessions: fakeSessionGateway({ send: async () => ({ ok: false, failed: "text" }) }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    expect(err).toContain("did not accept the write");
    expect(err).toContain("Nothing was written, so sending it again is safe");
  });

  it("tells a half-delivered send NOT to resend the text (#462 review round 2)", async () => {
    await withRegisteredCore();
    // Two writes have three outcomes. The one a boolean could not express is
    // this one: the text is on the PTY and the return is not. Reporting it as
    // "the write was refused" sends the operator to the single worst next move,
    // because a resend now carries a return of its own and submits the text
    // twice. The `--wait` path has drawn this line since #289; #404 put the
    // second write on the default path, so this path draws it too.
    const run = await cli().run(["session", "send", "task_1", "hello"], {
      sessions: fakeSessionGateway({
        send: async () => ({ ok: false, failed: "carriage-return" }),
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    expect(err).toContain("took the text");
    expect(err).toContain("no turn was started");
    expect(err).toContain("do not send it again");
    // And it names the command that finishes the job without repeating the text.
    expect(err).toContain("actana session send task_1 --enter");
    // The message the *other* failure gets must not appear here: "nothing was
    // written" is exactly what is untrue in this case.
    expect(err).not.toContain("Nothing was written");
  });

  it("does not tell a bare --enter not to resend text it never sent", async () => {
    await withRegisteredCore();
    // `send $SID --enter` with no text is a carriage return and nothing else, so
    // a refused return leaves nothing on the PTY. The "do not send it again"
    // advice would be about text that does not exist, and a resend here is the
    // right move rather than the doubling one.
    const run = await cli().run(["session", "send", "task_1", "--enter"], {
      sessions: fakeSessionGateway({
        send: async () => ({ ok: false, failed: "carriage-return" }),
      }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    expect(err).toContain("did not accept the carriage return");
    expect(err).toContain("Nothing was written, so sending it again is safe");
    expect(err).not.toContain("took the text");
    expect(err).not.toContain("do not send it again");
  });

  it("keeps the request and the outcome apart in --json", async () => {
    await withRegisteredCore();
    // `enter` is what was asked for and keeps its old meaning; `submitted` is
    // what happened. They agree on every path but this one, which is the path
    // worth telling apart — and `failed` says which half went missing, so a
    // script can tell a safe resend from a doubling one.
    const half = await cli().run(["session", "send", "task_1", "hello", "--json"], {
      sessions: fakeSessionGateway({
        send: async () => ({ ok: false, failed: "carriage-return" }),
      }),
    });
    expect(JSON.parse(half.out.join("\n"))).toMatchObject({
      enter: true,
      submitted: false,
      delivered: false,
      failed: "carriage-return",
    });

    const refused = await cli().run(["session", "send", "task_1", "hello", "--json"], {
      sessions: fakeSessionGateway({ send: async () => ({ ok: false, failed: "text" }) }),
    });
    expect(JSON.parse(refused.out.join("\n"))).toMatchObject({
      submitted: false,
      delivered: false,
      failed: "text",
    });

    // And a success carries no `failed` key at all, so its absence is the signal.
    const fine = await cli().run(["session", "send", "task_1", "hello", "--json"], {
      sessions: fakeSessionGateway({ send: async () => ({ ok: true }) }),
    });
    const document = JSON.parse(fine.out.join("\n"));
    expect(document).toMatchObject({ enter: true, submitted: true, delivered: true });
    expect(document.failed).toBeUndefined();
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
