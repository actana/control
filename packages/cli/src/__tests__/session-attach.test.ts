// `actana session attach`, against a fake terminal and a fake Session (#163).
//
// The suite is organised around the ticket's "done when" rather than around the
// command's code, because those four lines are the reason this command is hard:
//
//   - **attaching to a Session somebody else is writing gives a read-only view
//     with a visible reason** — not an error, and not a silent steal.
//   - **detaching releases the lock, and so does the connection dropping.** The
//     second is the one that gets missed, and the asymmetry is the assertion:
//     a detach sends a `release`, a dropped link deliberately does not, because
//     the Core has already done it (ADR 0024 D7) and asking a socket that is
//     gone is how a teardown hangs.
//   - **two attaches on one Session: one writes, one reads.** Here as the two
//     halves separately — a granted claim types, a refused one does not — and in
//     `session-attach-live.test.ts` as two clients contending for real.
//   - **the terminal is restored on every exit path.** One test per path, and
//     the list of paths is the point.
//
// Every one of those is a failure nobody can stage against a real Core on
// demand, which is why `deps.terminal` and `deps.openAttach` are injected at
// all. The fake terminal records raw-mode calls instead of performing them, so
// "did it restore?" is an assertion rather than an operator noticing their shell
// has stopped echoing.

import { describe, it, expect, afterEach } from "vitest";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../exit-codes.ts";
import { SessionGatewayError } from "../session-gateway.ts";
import {
  fakeAttachment,
  fakeTerminal,
  makeCliFixture,
  registerCore,
  type CliFixture,
  type FakeAttachment,
  type FakeTerminal,
} from "./cli-harness.ts";
import type { AttachAuthority } from "../session-attach-channel.ts";

/** `Ctrl-]`, the detach key, and `Ctrl-C`, which is the harness's. */
const DETACH = "\u001D";
const CTRL_C = "\u0003";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** A registered Core, so resolution has something to find. */
async function withRegisteredCore(): Promise<void> {
  registerCore(cli().paths, "prod");
}

type AttachOpts = {
  authority?: AttachAuthority;
  backlog?: string;
  terminal?: FakeTerminal;
  attachment?: FakeAttachment;
  argv?: string[];
};

/**
 * Attach, and hand back the pieces with the session guaranteed to be fully
 * wired — every listener registered — before the test acts on it.
 */
async function attach(opts: AttachOpts = {}) {
  await withRegisteredCore();
  const terminal = opts.terminal ?? fakeTerminal();
  const attachment =
    opts.attachment ??
    fakeAttachment({
      ...(opts.authority === undefined ? {} : { authority: opts.authority }),
      ...(opts.backlog === undefined ? {} : { backlog: opts.backlog }),
    });
  const asked: Array<{ taskId: string; claimWrite: boolean; cols: number; rows: number }> = [];

  const run = cli().run(opts.argv ?? ["session", "attach", "task_1"], {
    terminal,
    openAttach: async (_blob, o) => {
      asked.push({ taskId: o.taskId, claimWrite: o.claimWrite, cols: o.cols, rows: o.rows });
      return attachment;
    },
  });
  await terminal.wired;
  return { run, terminal, attachment, asked };
}

describe("the write lock is the first thing this command settles (ADR 0024 D3–D7)", () => {
  it("claims it, says so, and forwards what is typed", async () => {
    const { run, terminal, attachment } = await attach({ authority: "held" });

    terminal.type("ls -la\r");
    terminal.type(DETACH);
    const result = await run;

    expect(result.code).toBe(EXIT_OK);
    expect(attachment.typed()).toBe("ls -la\r");
    // The reason is on the line before the screen fills, not discovered later by
    // having a keystroke refused.
    expect(result.err.join("\n")).toContain("You hold the write lock");
  });

  it("gives a read-only view with the reason on it, rather than an error or a steal", async () => {
    // The ticket's first criterion, whole. Another Core client holds this
    // Session: the attach opens, says why it cannot type, forwards nothing, and
    // ends successfully — an attach that exited non-zero here would make
    // "somebody else is driving" indistinguishable from "the Core is down".
    const { run, terminal, attachment } = await attach({ authority: "held-by-another" });

    terminal.type("rm -rf /\r");
    terminal.type(DETACH);
    const result = await run;

    expect(result.code).toBe(EXIT_OK);
    expect(attachment.typed()).toBe("");
    const said = result.err.join("\n");
    expect(said).toContain("READ-ONLY");
    expect(said).toContain("another Core client holds this Session's write lock");
    // And it says how many keystrokes went nowhere, once, at the end — rather
    // than repainting the Session's screen with a warning per key.
    expect(said).toContain("keystrokes were not forwarded");
  });

  it("still reads the Session it may not write — a Reader is not a refusal", async () => {
    const { run, terminal, attachment } = await attach({
      authority: "held-by-another",
      backlog: "the scrollback\r\n",
    });

    attachment.emit("a line the other client's harness printed\r\n");
    terminal.type(DETACH);
    await run;

    expect(terminal.painted()).toContain("the scrollback");
    expect(terminal.painted()).toContain("a line the other client's harness printed");
  });

  it("`--read-only` sends no claim at all", async () => {
    // Not the same thing as being refused one. A Session starts unlocked (D5),
    // so an ordinary attach on an unclaimed Session takes the lock — and an
    // operator who only meant to watch an automation would take it from the
    // automation that was about to claim.
    const { run, terminal, asked, attachment } = await attach({
      authority: "not-claimed",
      argv: ["session", "attach", "task_1", "--read-only"],
    });

    terminal.type("hello");
    terminal.type(DETACH);
    const result = await run;

    expect(asked[0]!.claimWrite).toBe(false);
    expect(attachment.typed()).toBe("");
    expect(result.err.join("\n")).toContain("--read-only");
    expect(result.code).toBe(EXIT_OK);
  });

  it("writes to a Core that has no lock table, and never calls that read-only", async () => {
    // `supported: false` is not `granted: false`. Such a Core serves every
    // mutation this client makes (D11), and rendering it read-only would tell an
    // operator who is its only client that somebody else is typing.
    const { run, terminal, attachment } = await attach({ authority: "no-lock-table" });

    terminal.type("echo hi\r");
    terminal.type(DETACH);
    const result = await run;

    expect(attachment.typed()).toBe("echo hi\r");
    expect(result.err.join("\n")).not.toContain("READ-ONLY");
    expect(result.err.join("\n")).toContain("no Session lock");
  });

  it("hands the lock back when the operator detaches", async () => {
    const { run, terminal, attachment } = await attach();

    terminal.type(DETACH);
    await run;

    expect(attachment.releaseCount()).toBe(1);
    expect(attachment.closeCount()).toBe(1);
  });

  it.each(["SIGINT", "SIGTERM"] as const)("hands it back on %s too", async (signal) => {
    // A signal is a detach somebody else asked for. The lock has to come back on
    // it for the same reason the terminal does: this process is going away and
    // the Session must not go with it.
    const { run, terminal, attachment } = await attach();
    terminal.raise(signal);

    const result = await run;
    expect(attachment.releaseCount()).toBe(1);
    expect(result.code).toBe(signal === "SIGINT" ? 130 : 143);
  });

  it("does not try to release over a link that has dropped — the Core already did", async () => {
    // **The case the ticket says gets missed**, from this side. A dropped
    // connection releases its locks at the Core (D7), so there is nothing to
    // send; sending anyway means a teardown waiting on a socket that is gone,
    // with the operator's terminal still raw behind it. The other half of this
    // claim — that the Session really is claimable again afterwards — is proved
    // against a real Core in `session-attach-live.test.ts`.
    const { run, attachment } = await attach();
    attachment.drop("socket hang up");

    const result = await run;
    expect(attachment.releaseCount()).toBe(0);
    expect(result.code).toBe(EXIT_FAILURE);
    // And the operator is told, because otherwise they would reasonably assume
    // the Session they were driving is now stuck.
    expect(result.err.join("\n")).toContain("claimable again");
  });

  it("does not tell an attach that held nothing that the Session is claimable again", async () => {
    // D7 releases the locks the dropped connection *held*, and a read-only
    // attach held none. The unconditional line was wrong twice over in the
    // operator's favour: this connection freed nothing, and the Session is still
    // held by the client that has it.
    const { run, attachment } = await attach({ authority: "held-by-another" });
    attachment.drop("socket hang up");
    const said = (await run).err.join("\n");

    expect(said).not.toContain("claimable again");
    expect(said).toContain("stays held by the client that does");
  });

  it("says a `--read-only` drop left the Session's lock exactly as it was", async () => {
    const { run, attachment } = await attach({
      authority: "not-claimed",
      argv: ["session", "attach", "task_1", "--read-only"],
    });
    attachment.drop("socket hang up");
    const said = (await run).err.join("\n");

    expect(said).not.toContain("claimable again");
    expect(said).toContain("leaves the Session's lock as it was");
  });

  it("does not claim a drop freed a lock this attach had already lost", async () => {
    const { run, terminal, attachment } = await attach();

    attachment.takeLock();
    terminal.type("x");
    await Promise.resolve();
    attachment.drop("socket hang up");
    const said = (await run).err.join("\n");

    expect(said).not.toContain("claimable again");
    expect(said).toContain("stays held by the client that took it");
  });

  it("gives the terminal back before the release goes out, not after", async () => {
    // Ordering, not politeness. A release is a round trip to a Core that may
    // have stopped answering, and every millisecond of it would be a millisecond
    // the operator's terminal was still raw.
    const terminal = fakeTerminal();
    const attachment = fakeAttachment();
    let rawAtRelease: boolean | null = null;
    const release = attachment.release.bind(attachment);
    attachment.release = async () => {
      rawAtRelease = terminal.isRaw();
      return release();
    };

    const { run } = await attach({ terminal, attachment });
    terminal.type(DETACH);
    await run;

    expect(rawAtRelease).toBe(false);
  });

  it("keeps reading after the lock is taken away, and says it happened", async () => {
    // D7's force takeover, from the losing end: the previous holder learns of it
    // on its next mutation and no sooner. An attach that quit on that would take
    // the operator's *view* away as well as their keyboard — and the Session is
    // still worth watching.
    const { run, terminal, attachment } = await attach();

    terminal.type("before\r");
    attachment.takeLock();
    terminal.type("after\r");
    await Promise.resolve();
    attachment.emit("output that arrived after the takeover\r\n");
    terminal.type(DETACH);
    const result = await run;

    expect(attachment.typed()).toBe("before\r");
    expect(terminal.painted()).toContain("taken this Session's write lock");
    expect(terminal.painted()).toContain("output that arrived after the takeover");
    expect(result.code).toBe(EXIT_OK);
    // Nothing left to give back: the lock moved, and a release frame for it
    // would be this client talking about a lock it no longer has.
    expect(attachment.releaseCount()).toBe(1);
  });
});

describe("the terminal is restored on every exit path", () => {
  it("restores it on a detach", async () => {
    const { run, terminal } = await attach();
    expect(terminal.isRaw()).toBe(true);

    terminal.type(DETACH);
    await run;

    expect(terminal.rawModeCalls).toEqual([true, false]);
    expect(terminal.isRaw()).toBe(false);
  });

  it("restores it when the harness exits underneath", async () => {
    const { run, terminal, attachment } = await attach();
    attachment.exit({ exitCode: 0 });

    const result = await run;
    expect(terminal.isRaw()).toBe(false);
    // Not this command's failure: an attach is a terminal onto somebody else's
    // Session, and a script that could not tell "the attach failed" from "the
    // harness you were watching exited 1" would be worse off than one that reads
    // the line.
    expect(result.code).toBe(EXIT_OK);
    expect(result.err.join("\n")).toContain("exited with code 0");
  });

  it("restores it when the connection drops", async () => {
    const { run, terminal, attachment } = await attach();
    attachment.drop("socket hang up");

    const result = await run;
    expect(terminal.isRaw()).toBe(false);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err.join("\n")).toContain("socket hang up");
  });

  it.each(["SIGINT", "SIGTERM"] as const)("restores it on %s", async (signal) => {
    const { run, terminal } = await attach();
    terminal.raise(signal);

    const result = await run;
    expect(terminal.isRaw()).toBe(false);
    expect(result.code).toBe(signal === "SIGINT" ? 130 : 143);
  });

  it("restores it when the Session stops accepting input for a reason that is not the lock", async () => {
    const { run, terminal, attachment } = await attach();
    attachment.breakWrites(new Error("write after end"));

    terminal.type("x");
    const result = await run;
    expect(terminal.isRaw()).toBe(false);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err.join("\n")).toContain("stopped accepting input");
  });

  it("never enters raw mode when the terminal refuses it — and releases the lock anyway", async () => {
    await withRegisteredCore();
    const terminal = fakeTerminal();
    terminal.breakRawMode(new Error("not a tty after all"));
    const attachment = fakeAttachment();

    const result = await cli().run(["session", "attach", "task_1"], {
      terminal,
      openAttach: async () => attachment,
    });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(terminal.rawModeCalls).toEqual([]);
    // The lock was taken by the claim that opened this attachment, and a Session
    // left locked by an attach that never opened is the stranding this ticket is
    // about.
    expect(attachment.releaseCount()).toBe(1);
    expect(attachment.closeCount()).toBe(1);
  });

  it("touches the terminal at all only after the Session is open", async () => {
    // A Core that is down, a Session that is not running and a session id that
    // does not exist are the ordinary failures of this command. None of them has
    // any business happening while the operator's terminal is in raw mode.
    await withRegisteredCore();
    const terminal = fakeTerminal();

    const result = await cli().run(["session", "attach", "task_gone"], {
      terminal,
      openAttach: async () => {
        throw new SessionGatewayError("no-such-session", "this Core has no session task_gone");
      },
    });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(terminal.rawModeCalls).toEqual([]);
    expect(result.err.join("\n")).toContain("this Core has no session task_gone");
  });
});

describe("the keyboard", () => {
  it("forwards Ctrl-C to the harness rather than dying on it", async () => {
    // The whole reason a person attaches instead of reading `session logs`. Raw
    // mode turns off `ISIG`, so this is the byte 0x03 and it belongs to whatever
    // the harness is running.
    const { run, terminal, attachment } = await attach();

    terminal.type(CTRL_C);
    expect(attachment.typed()).toBe(CTRL_C);

    terminal.type(DETACH);
    const result = await run;
    expect(result.code).toBe(EXIT_OK);
  });

  it("treats Ctrl-C as a detach when there is nothing to interrupt", async () => {
    // Read-only: nothing is forwarded, so a `Ctrl-C` that did nothing at all
    // would be a key that appears broken. Here it means the only thing left it
    // can mean.
    const { run, terminal } = await attach({ authority: "held-by-another" });

    terminal.type(CTRL_C);
    const result = await run;
    expect(result.code).toBe(EXIT_OK);
    expect(result.err.join("\n")).toContain("Detached from session task_1");
  });

  it("makes Ctrl-C a detach once the lock has been taken away", async () => {
    // The honest reading of a demoted attach: it is a Reader now, so `Ctrl-C`
    // means what it means for every other Reader. Gating it on the authority
    // this attach *opened* with left the key doing nothing at all — not
    // forwarded, because there is no lock, and not a detach, because the
    // read-only affordance never activated — which is the one outcome the
    // operator cannot act on. They are told, on the terminal, at the moment it
    // changes.
    const { run, terminal, attachment } = await attach();

    attachment.takeLock();
    terminal.type("into the void\r");
    await Promise.resolve();
    expect(terminal.painted()).toContain("Ctrl-C now detaches");

    terminal.type(CTRL_C);
    const result = await run;

    expect(result.code).toBe(EXIT_OK);
    expect(result.err.join("\n")).toContain("Detached from session task_1");
    // And it is still a detach rather than a stray keystroke on the new holder's
    // harness: nothing after the takeover reached the far side.
    expect(attachment.typed()).toBe("");
  });

  it("says the lock was lost rather than that the attach was read-only", async () => {
    // An attach that opened holding the lock and had it taken was not read-only;
    // it was demoted. Telling the operator they had been read-only all along
    // describes a session they did not have.
    const { run, terminal, attachment } = await attach();

    attachment.takeLock();
    // The chunk that discovers the takeover is refused on the wire and answered
    // on the terminal there and then; the tally is for the ones typed after,
    // when this attach already knew it could not write.
    terminal.type("x");
    await Promise.resolve();
    terminal.type("abc");
    terminal.type(DETACH);
    const said = (await run).err.join("\n");

    expect(said).toContain("3 keystrokes were not forwarded");
    expect(said).toContain("lost the write lock partway through");
    expect(said).not.toContain("this attach was read-only");
  });

  it("forwards what was typed before the detach key and nothing after it", async () => {
    // A chunk can carry both — a fast typist, or a paste. The bytes before the
    // key are keystrokes the operator meant; the ones after it were typed at a
    // terminal that is no longer attached to anything.
    const { run, terminal, attachment } = await attach();

    terminal.type(`hello${DETACH}goodbye`);
    await run;

    expect(attachment.typed()).toBe("hello");
  });

  it("counts what a read-only attach did not forward, and reports it once", async () => {
    const { run, terminal } = await attach({ authority: "held-by-another" });

    terminal.type("abc");
    terminal.type("de");
    terminal.type(DETACH);
    const result = await run;

    expect(result.err.join("\n")).toContain("5 keystrokes were not forwarded");
  });
});

describe("the screen", () => {
  it("paints the scrollback before the live stream, in that order", async () => {
    const { run, terminal, attachment } = await attach({ backlog: "history\r\n" });

    attachment.emit("present\r\n");
    terminal.type(DETACH);
    await run;

    expect(terminal.painted().indexOf("history")).toBeLessThan(terminal.painted().indexOf("present"));
  });

  it("propagates a resize while it holds the lock", async () => {
    const { run, terminal, attachment } = await attach();

    terminal.resizeTo(120, 40);
    terminal.type(DETACH);
    await run;

    expect(attachment.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("does not resize the PTY from a read-only attach", async () => {
    // The Core would accept it — `resize` is not gated on the lock (D4 covers
    // `write`, `kill` and task mutations). This is the CLI's own restraint:
    // reflowing the terminal of the person actually typing because an observer
    // widened a window is interference in the one direction the lock cannot see.
    const { run, terminal, attachment } = await attach({ authority: "held-by-another" });

    terminal.resizeTo(200, 60);
    terminal.type(DETACH);
    await run;

    expect(attachment.resizes).toEqual([]);
  });

  it("stops resizing the PTY the moment the lock is taken away", async () => {
    // The same restraint as the read-only case, but for the attach that used to
    // be allowed — and the one that actually does damage. The Core does not gate
    // `resize` on the lock, so a demoted attach that kept sending them reflows
    // the *new* holder's PTY: somebody else's full-screen harness redrawn
    // because this window changed size, from the one client whose frames the
    // lock cannot see coming.
    const { run, terminal, attachment } = await attach();

    terminal.resizeTo(120, 40);
    attachment.takeLock();
    terminal.type("x");
    await Promise.resolve();
    terminal.resizeTo(200, 60);
    terminal.type(DETACH);
    await run;

    expect(attachment.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("tells the Core the terminal's size when it attaches", async () => {
    const { run, terminal, asked } = await attach({ terminal: fakeTerminal({ cols: 132, rows: 43 }) });

    terminal.type(DETACH);
    await run;

    expect(asked[0]).toMatchObject({ taskId: "task_1", cols: 132, rows: 43 });
  });
});

describe("the command line", () => {
  it("refuses --json, because there is no document to emit", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "attach", "task_1", "--json"], {
      terminal: fakeTerminal(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("hands you a terminal");
    // And it names the verb that *is* the machine-readable view.
    expect(run.err.join("\n")).toContain("session logs");
  });

  it("wants a session id, and only one", async () => {
    await withRegisteredCore();
    const none = await cli().run(["session", "attach"], { terminal: fakeTerminal() });
    expect(none.code).toBe(EXIT_USAGE);
    expect(none.err.join("\n")).toContain("a session id is required");

    const two = await cli().run(["session", "attach", "task_1", "task_2"], {
      terminal: fakeTerminal(),
    });
    expect(two.code).toBe(EXIT_USAGE);
    expect(two.err.join("\n")).toContain('unexpected argument "task_2"');
  });

  it("refuses a flag that belongs to another verb rather than ignoring it", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "attach", "task_1", "--wait"], {
      terminal: fakeTerminal(),
    });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("--wait does not apply here");
  });

  it("refuses `--read-only` on a verb that does not attach", async () => {
    await withRegisteredCore();
    const run = await cli().run(["session", "kill", "task_1", "--read-only"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("--read-only does not apply here");
  });
});
