// Reaching a Core for the `session` noun (#129 D10, #160).
//
// The same seam `core-probe.ts` opened for `core status`, widened exactly as
// its header said it would be: one module that dials, so the noun above it —
// flags, tables, `--json` shapes, exit codes — is exercised by unit tests with
// no Core anywhere near them. Everything in this file is behind
// {@link OpenSessionGateway}, which `actana-cli-entry.ts` binds to the real
// implementation and the test harness binds to a fake.
//
// **This file is where the SDK is used, and it is used and not re-implemented.**
// Three rules that live here rather than in the command module, because they
// are properties of talking to a Core rather than of printing:
//
//   1. **The Core delivers prompts (ADR 0026, #129 D3).** A starting prompt is
//      handed to `CoreSession.start` as `prompt` and that is the whole of the
//      CLI's involvement. Nothing here waits for a harness to look ready,
//      re-sends anything, or presses Enter after a pause — no timer of any kind
//      appears in this package, and `src/__tests__/no-prompt-timing.test.ts` is
//      what keeps that true. A prompt that does not arrive is a Core bug, and a
//      client that papered over it would hide the bug from the one machine that
//      can fix it and would behave differently from every other client.
//   2. **A transcript is a screen, not a byte log.** `logs` renders the Core's
//      replay ring through the SDK's `TerminalScreen` — the same emulator the
//      session layer builds `screen()` from. A harness paints with cursor moves
//      and repaints one row eighty times a second; concatenating that stream
//      raw produces spinner soup, not a transcript. `--raw` still exists for a
//      caller piping into a terminal that will do the rendering itself.
//   3. **Idleness is the Core's report.** `--wait` is `CoreSession.waitForIdle`,
//      which watches the Core's event log for a status the Core decided on.
//      Nothing here inspects output for quietness.
//
// Everything this module hands back is plain data or a small object with
// methods — no `CoreClient`, no `CoreSession`, no frames escape it. That is
// what keeps `session-command.ts` free of the SDK and free of a socket.

import { CoreClient } from "@actana/sdk/core-client.ts";
import {
  CoreSession,
  CoreSessionAttachError,
  HARNESS_LAUNCH_COMMANDS,
} from "@actana/sdk/core-session.ts";
import { TerminalScreen, DEFAULT_COLS, DEFAULT_ROWS } from "@actana/sdk/terminal-screen.ts";
import { harnessResumeCommand } from "./harness-resume.ts";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkPtySpawnHarness,
  CoreLinkSessionLockState,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";

/** The harnesses this build knows, in the order `--help` lists them. */
export const KNOWN_HARNESSES: readonly CoreLinkPtySpawnHarness[] = Object.keys(
  HARNESS_LAUNCH_COMMANDS,
) as CoreLinkPtySpawnHarness[];

/** The harness a `session start` gets when neither the flag nor the Project names one. */
export const DEFAULT_HARNESS: CoreLinkPtySpawnHarness = "claude-code";

/** Is this string one of the harnesses the Core can be asked for? */
export function isKnownHarness(value: string): value is CoreLinkPtySpawnHarness {
  return (KNOWN_HARNESSES as readonly string[]).includes(value);
}

/**
 * What went wrong, in a vocabulary the command module can turn into a message
 * and an exit code without parsing English out of an SDK error.
 *
 * The kinds are the situations a person actually lands in, and each is a
 * different next step: a Task id that does not exist is a typo, a Session with
 * no live PTY is a harness that has already exited, a Task the harness never
 * reported a session id for has nothing to resume *from*, and a Session that is
 * already running is one to `send` to rather than start again. Anything the
 * Core refused for its own reasons arrives as `refused` carrying the Core's own
 * message — this side does not paraphrase a machine it is not on.
 */
export type SessionGatewayErrorKind =
  | "no-such-session"
  | "no-such-project"
  | "not-running"
  | "already-running"
  | "nothing-to-resume"
  | "refused";

export class SessionGatewayError extends Error {
  readonly kind: SessionGatewayErrorKind;
  constructor(kind: SessionGatewayErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionGatewayError";
    this.kind = kind;
  }
}

/** One row of `actana session ls`. */
export type SessionRow = {
  taskId: string;
  title: string;
  /** The harness on the Task row, as the Core spells it. */
  harness: string;
  /** The Core's status for the Session — `running`, `finished`, `needs-input`, … */
  status: string;
  projectId: string;
  /** The Project's name, or null when the Task points at a Project the Core did not list. */
  project: string | null;
  /** The live PTY, or null when nothing is running for this Task right now. */
  ptyId: string | null;
  /** Whether a harness process is running for this Task — `ptyId !== null`, named. */
  live: boolean;
  /**
   * Whether *this* client may write to the Session, and which of the three lock
   * states it is in — both null on a Core that does not publish lock state (ADR
   * 0024). Null is "this Core has no lock table", not "you may not write".
   */
  writable: boolean | null;
  lock: CoreLinkSessionLockState | null;
  updatedAt: number;
};

export type SessionStartRequest = {
  /** A Project id, or a Project name, exactly as it was typed. */
  project: string;
  /** The starting prompt. Handed to the Core to deliver; never timed here. */
  prompt?: string;
  title?: string;
  /** `--harness`, or null to take the Project's remembered one (ADR 0017). */
  harness: CoreLinkPtySpawnHarness | null;
  /** `--cwd` on the **Core's** machine, or null for the Project root. */
  cwd: string | null;
  dangerouslySkipPermissions: boolean;
};

export type SessionResumeRequest = {
  taskId: string;
  prompt?: string;
  dangerouslySkipPermissions: boolean;
};

/** How a Session ended up, once the Core reported it settled. */
export type SessionOutcome = {
  /** One of the settled statuses — `finished`, `needs-input`, `interrupted`, … */
  status: string;
  /** True when the harness's process exited rather than settling on a status. */
  exited: boolean;
  exitCode?: number;
};

/**
 * A Session this invocation is connected to, and can wait on.
 *
 * `start` and `resume` produce one by spawning; `wait` and `send --wait` produce
 * one by attaching to a harness that is already running (#289). The fields are
 * the same fields so the two print the same object — and the ones only a spawn
 * can answer say so with `null` rather than with a plausible value.
 */
export type StartedSession = {
  taskId: string;
  ptyId: string;
  /**
   * The harness running in it, as the Core spells it — `null` only when this
   * invocation attached to a Session whose Task row the Core did not list, which
   * is a row deleted out from under a live PTY. The wait does not need it; it is
   * on the object because a caller reading the result wants to know what it was
   * talking to.
   */
  harness: string | null;
  /**
   * The command the Core was asked to run, after defaulting — `null` on a
   * Session this invocation attached to rather than started, because the Core
   * does not publish a running PTY's command.
   */
  command: string | null;
  /**
   * Will anything move this Session to `running` when a turn begins?
   *
   * The Core's answer for this Session, off the spawn (issue 84, issue 177
   * finding 4) — not a property of the harness family, because it depends on
   * which hooks actually landed on that machine and on whether the vendor
   * fires them. `false` for `cursor-cli` today: the Core writes
   * `.cursor/hooks.json` and cursor-agent never fires `beforeSubmitPrompt`.
   *
   * The CLI's job with it is to say so. `--wait` still works — turn *end* is
   * reported, which is what `waitForIdle` waits for — but everything between
   * the prompt and the stop is invisible, so a `session ls` run against a
   * working cursor Session shows the status it had before the turn began. An
   * operator told that is reading a quiet table correctly; one who is not has
   * no way to tell it from a harness that never started.
   *
   * **`null` on an attached Session** — `session wait` and `send --wait` join a
   * PTY that is already running, and the Core answers this question on a spawn.
   * Null is "not asked on this path", not "no", and nothing about waiting reads
   * it either way (#289 A).
   */
  reportsTurnStart: boolean | null;
  projectId: string;
  /** The Project's name, when the start resolved one. */
  project: string | null;
  /**
   * Block until the Core reports this Session settled.
   *
   * The SDK's wait, which is the Core's event log — see rule 3 in the header.
   * `timeoutMs` is a deadline the *operator* asked for (`--wait-timeout`) and
   * its expiry is an error, never a status invented here.
   *
   * **What "settled" counts from depends on how this Session was reached.** A
   * spawned one has observed no status, so the first it hears is this turn's. An
   * attached one carries the delivery stamp the Core answered its write with, so
   * the status that ends the wait is one reported *after* the text went in — not
   * the one the Session was already parked at (#289 A).
   */
  wait(opts: { timeoutMs?: number }): Promise<SessionOutcome>;
  /** The rendered transcript, read while the Session is alive. */
  screen(): string;
  /** Release the listeners this Session holds. The harness keeps running. */
  dispose(): void;
};

/** What `actana session logs` reads back. */
export type SessionLogs = {
  taskId: string;
  ptyId: string;
  /** The replay ring rendered as a terminal would show it, scrollback included. */
  screen: string;
  /** The same bytes unrendered, for a caller piping into a real terminal. */
  raw: string;
};

/**
 * What one `send` got onto the PTY.
 *
 * A boolean was enough while there was only ever one write. Since #404 a send is
 * two — the text, then the carriage return that submits it — and two writes have
 * **three** outcomes, not two. The one that a boolean cannot express is the one
 * that matters: the text landed and the return did not.
 *
 * That case is not "the write was refused", and reporting it as such tells the
 * operator to do the single worst thing available — send again, which now
 * carries a return of its own and submits the text twice. `failed` is what lets
 * the caller say which half went missing, and therefore whether a resend is safe.
 */
export type SendResult =
  /** Everything the caller asked for is on the PTY. */
  | { ok: true }
  /**
   * Nothing was written. The text was refused, so the Session has not seen it
   * and sending it again is safe.
   */
  | { ok: false; failed: "text" }
  /**
   * **Whatever text there was is on the PTY and the carriage return is not**, so
   * no turn was started. Text that landed must not be sent again; the return
   * alone finishes it. On a send that carried no text — a bare `--enter` — there
   * is nothing to have half-landed, and the caller is the one that knows which
   * of the two it is holding.
   */
  | { ok: false; failed: "carriage-return" };

/** Everything the `session` noun asks of a Core, and nothing else. */
export type SessionGateway = {
  /** `null` lists every Project's Sessions; a string filters by Project name or id. */
  list(project: string | null): Promise<SessionRow[]>;
  start(request: SessionStartRequest): Promise<StartedSession>;
  resume(request: SessionResumeRequest): Promise<StartedSession>;
  logs(taskId: string): Promise<SessionLogs>;
  /**
   * Write text to a running Session, verbatim. `enter` adds a carriage return as
   * a **separate write to the same PTY**, resolved once for both, so there is no
   * window between them in which the text lands and the return is sent somewhere
   * else — or nowhere.
   *
   * Still an option and still off when it is not passed: this is the mechanism,
   * and *whether a send submits* is the command's decision, made once in
   * `sessionSend` (#404). The gateway writing a return nobody asked for would
   * put that decision in two places.
   *
   * Answers with {@link SendResult} rather than a boolean, because two writes
   * have three outcomes and only one of them is "nothing happened".
   */
  send(taskId: string, text: string, opts?: { enter?: boolean }): Promise<SendResult>;
  /**
   * Attach to a running Session and hand back something to wait on — the
   * primitive `actana session wait` is (#289 B).
   *
   * No text goes in, so there is no delivery to count from: the wait it returns
   * answers from the status the Session is in when it is already settled, and
   * otherwise on the next settling status. That is the honest answer to "tell me
   * when this Session is not working", which is what the verb asks.
   */
  wait(taskId: string): Promise<StartedSession>;
  /**
   * Write text into a running Session and hand back a wait for **the turn that
   * write starts** — one PTY resolution for both, and no window between them.
   *
   * The wait counts from the event id the Core stamped the delivery with, so a
   * Session that was already settled when the text arrived cannot answer it with
   * the status it was already sitting at (#289 A, and the `settledNow` landmine
   * that is the reason the stamp exists).
   */
  sendAndWait(taskId: string, text: string, opts?: { enter?: boolean }): Promise<StartedSession>;
  /** Kill the harness running for this Task, whoever started it. */
  kill(taskId: string): Promise<{ ptyId: string; killed: boolean }>;
  close(): void;
};

/** How the `session` noun reaches a Core. Injected, so every verb is testable. */
export type OpenSessionGateway = (
  blob: CoreRegistrationBlob,
  opts: { timeoutMs: number },
) => Promise<SessionGateway>;

/**
 * The real gateway: connect, and hand back the verbs bound to that connection.
 *
 * Connecting here rather than per verb is deliberate — every `session` verb
 * needs a live socket, and a command that dialled twice would double the
 * latency of the fast path (`ls`) for no gain.
 */
export const openSessionGateway: OpenSessionGateway = async (blob, opts) => {
  const client = CoreClient.fromRegistrationBlob(blob, {
    connectTimeoutMs: opts.timeoutMs,
    requestTimeoutMs: opts.timeoutMs,
  });
  await client.connect();
  return new CoreLinkSessionGateway(client);
};

class CoreLinkSessionGateway implements SessionGateway {
  constructor(private readonly client: CoreClient) {}

  async list(project: string | null): Promise<SessionRow[]> {
    const projects = await this.client.projectsList();
    const projectId = project === null ? undefined : this.resolveProject(projects, project).projectId;

    // Two reads because they answer two questions: `sessionsList` is the
    // Session view (status, the live PTY, this client's lock) and the Task rows
    // carry what a person reads a list by — the title, the harness, the Project.
    // Neither frame carries the other's fields, and joining here costs one round
    // trip against a list nobody paginates.
    const [sessions, tasks] = await Promise.all([
      this.client.sessionsList(projectId),
      this.client.tasksList(projectId),
    ]);
    const byTask = new Map(tasks.tasks.map((task) => [task.taskId, task]));
    const projectNames = new Map(projects.map((p) => [p.projectId, p.name]));

    return sessions.map((session) => {
      const task = byTask.get(session.taskId);
      return {
        taskId: session.taskId,
        title: task?.title ?? "(untitled)",
        harness: task?.agent ?? "(unknown)",
        status: session.status,
        projectId: task?.projectId ?? "",
        project: task ? (projectNames.get(task.projectId) ?? null) : null,
        ptyId: session.ptyId,
        live: session.ptyId !== null,
        writable: session.lock?.writable ?? null,
        lock: session.lock?.state ?? null,
        updatedAt: session.updatedAt,
      };
    });
  }

  async start(request: SessionStartRequest): Promise<StartedSession> {
    const projects = await this.client.projectsList();
    const project = this.resolveProject(projects, request.project);
    const harness = request.harness ?? rememberedHarness(project) ?? DEFAULT_HARNESS;

    const session = await this.begin({
      projectId: project.projectId,
      cwd: request.cwd ?? project.path,
      harness,
      title: request.title ?? titleFor(request.prompt),
      prompt: request.prompt,
      dangerouslySkipPermissions: request.dangerouslySkipPermissions,
    });
    return wrap(session, {
      projectId: project.projectId,
      project: project.name,
      harness,
    });
  }

  async resume(request: SessionResumeRequest): Promise<StartedSession> {
    const task = await this.findTask(request.taskId);

    // A Task with a live PTY is a Session that never stopped. Starting a second
    // harness on the same row would leave two processes writing one transcript
    // and one of them unreachable — `session send` and `session logs` resolve a
    // Task to *the* PTY, and there would be two.
    const live = await this.client.findByTask(task.taskId);
    if (live.ptyId !== null) {
      throw new SessionGatewayError(
        "already-running",
        `session ${task.taskId} is already running (pty ${live.ptyId})`,
      );
    }

    // The harness's own id for the conversation, written on the Task row by the
    // Core's hook pipeline. Absent means no harness ever reported one — there is
    // nothing to resume, and inventing an id would start a fresh Session while
    // claiming to have continued one.
    if (!task.claudeSessionId) {
      throw new SessionGatewayError(
        "nothing-to-resume",
        `session ${task.taskId} has no harness session id on it — nothing was recorded to resume from`,
      );
    }
    if (!isKnownHarness(task.agent)) {
      throw new SessionGatewayError(
        "refused",
        `session ${task.taskId} ran under "${task.agent}", which this build cannot start`,
      );
    }

    const project = await this.projectFor(task.projectId);
    const session = await this.begin({
      taskId: task.taskId,
      cwd: project.path,
      harness: task.agent,
      command: harnessResumeCommand(task.agent, task.claudeSessionId, {
        dangerouslySkipPermissions: request.dangerouslySkipPermissions,
      }),
      prompt: request.prompt,
      dangerouslySkipPermissions: request.dangerouslySkipPermissions,
    });
    return wrap(session, {
      projectId: project.projectId,
      project: project.name,
      harness: task.agent,
    });
  }

  async logs(taskId: string): Promise<SessionLogs> {
    const ptyId = await this.livePty(taskId);
    const replay = await this.client.replay(ptyId);

    // Rule 2 in the header, in four lines. The screen is built at the Core's own
    // default PTY size because the protocol carries no way to ask what size this
    // PTY actually is; a Session started at another size wraps differently here
    // than it does there, which is the one inaccuracy this verb has and the
    // reason `--raw` exists beside it.
    const terminal = new TerminalScreen({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    terminal.write(replay.data);
    return { taskId, ptyId, screen: terminal.text(), raw: replay.data };
  }

  async send(taskId: string, text: string, opts: { enter?: boolean } = {}): Promise<SendResult> {
    // One resolution for the whole verb. Resolving again for the return would
    // open a window — the harness exits between the two round trips, the text
    // has landed, and the command reports a failure after a partial delivery.
    const ptyId = await this.livePty(taskId);

    // Verbatim, and that is the whole verb. See rule 1: nothing is added on a
    // timer, nothing is retried. The return is its own write of its own byte —
    // never glued to the text — and it goes only because the caller asked.
    if (text.length > 0 && !(await this.client.write(ptyId, text))) {
      return { ok: false, failed: "text" };
    }
    if (!opts.enter) return { ok: true };
    // Its own write, never `text + "\r"`. A harness that treats a paste as one
    // unit would otherwise swallow the return with the characters and start no
    // turn — the failure #404 is about, arriving by the other door.
    //
    // **And its own failure.** The text is already on the PTY at this point, so
    // reporting this as "the write was refused" would tell an operator to do the
    // one thing that makes it worse: send again, which now carries a return and
    // submits the text twice. The `--wait` path has said this since #289
    // (`attached`, below); since #404 put the return on the default path, the
    // plain path needs it too.
    if (!(await this.client.write(ptyId, "\r"))) {
      return { ok: false, failed: "carriage-return" };
    }
    return { ok: true };
  }

  async wait(taskId: string): Promise<StartedSession> {
    return this.attached(taskId, null);
  }

  async sendAndWait(
    taskId: string,
    text: string,
    opts: { enter?: boolean } = {},
  ): Promise<StartedSession> {
    return this.attached(taskId, { text, enter: opts.enter === true });
  }

  async kill(taskId: string): Promise<{ ptyId: string; killed: boolean }> {
    // Resolved through the Core by Task id, which is what makes killing a
    // Session this CLI did not start ordinary rather than special: the PTY
    // belongs to the Core, and every client names it the same way. The only
    // Session this refuses is one another client holds the write lock on, and
    // that refusal is the Core's (ADR 0024).
    const ptyId = await this.livePty(taskId);
    const killed = await this.client.kill(ptyId);
    return { ptyId, killed };
  }

  close(): void {
    this.client.close();
  }

  // ─── Shared resolution ─────────────────────────────────────────────────────

  /**
   * Attach to a running Session, optionally deliver text into it first, and wrap
   * the result as a {@link StartedSession} to wait on.
   *
   * **One PTY resolution covers the write and the wait.** `CoreSession.attach`
   * resolves the Task's live PTY once and wires the byte stream, the exit and
   * the event log before this method writes a character; the write goes to that
   * PTY and the wait counts from the id the Core answered it with. There is no
   * second `findByTask` between them, so there is no window in which the harness
   * could move, exit, or finish a turn unobserved.
   *
   * The delivery is two writes when the caller asked for the return — the text,
   * then the carriage return, exactly as `send` has always done it (ADR 0026:
   * this side appends nothing the caller did not ask for). Both are stamped and
   * the wait counts from the **later** stamp, because the turn starts at the
   * return, not at the text. Since #404 the command asks for it by default, so
   * this is the ordinary path rather than the flagged one.
   */
  private async attached(
    taskId: string,
    deliver: { text: string; enter: boolean } | null,
  ): Promise<StartedSession> {
    // The archived list as a fallback, because a Session can be archived while
    // its harness is still running — and `tasksList` is active rows only by
    // design (ADR 0019). Every other verb that names a live PTY works on such a
    // Session; refusing it here would make `wait` the odd one out over a row
    // this only reads two display fields off.
    const task = await this.findAnyTask(taskId);
    const project =
      task === null ? null : await this.projectFor(task.projectId).catch(() => null);

    let session: CoreSession;
    try {
      session = await CoreSession.attach(this.client, { taskId });
    } catch (err) {
      // A Session with no live PTY is the one failure this path has that the
      // others do not, and it is `not-running` here for the same reason it is
      // there: it is a harness that has exited, and the next step is `logs` or
      // `resume`, not a retry.
      throw err instanceof CoreSessionAttachError
        ? new SessionGatewayError("not-running", err.message, { cause: err })
        : new SessionGatewayError("refused", messageOf(err), { cause: err });
    }

    let afterEventId = 0;
    if (deliver !== null) {
      try {
        if (deliver.text.length > 0) {
          const wrote = await session.deliver(deliver.text);
          if (!wrote.ok) {
            throw new SessionGatewayError(
              "not-running",
              `the Core did not accept the write to session ${taskId}`,
            );
          }
          afterEventId = Math.max(afterEventId, wrote.deliveryEventId);
        }
        if (deliver.enter) {
          const returned = await session.deliver("\r");
          if (!returned.ok) {
            throw new SessionGatewayError(
              "not-running",
              `the Core did not accept the carriage return for session ${taskId}`,
            );
          }
          afterEventId = Math.max(afterEventId, returned.deliveryEventId);
        }
        // **A delivery that was not stamped has no cursor, and an uncursored
        // wait after a delivery is the lie this whole design exists to
        // prevent** — it would answer from the status the Session was already
        // parked at, which is last turn's answer with a zero exit.
        //
        // The version gate refuses a Core too old to stamp before a frame goes
        // out. This covers the ways a Core on this version still answers 0: no
        // event-log port wired, or an `appendEvent` that failed. Both are
        // documented on `recordSessionDelivery`, and neither is a reason to
        // guess.
        //
        // The text **was delivered** and the message says so, because the next
        // thing an operator does with a failure here must not be to send it
        // again.
        //
        // Guarded on a write having happened at all: a delivery of nothing is
        // not a delivery, and it leaves this exactly where a bare `wait` is —
        // no cursor, because nothing was sent to count from.
        if ((deliver.text.length > 0 || deliver.enter) && afterEventId === 0) {
          throw new SessionGatewayError(
            "refused",
            `session ${taskId} took the text, but this Core did not record the delivery in its ` +
              `event log — so there is no cursor to await this turn from, and waiting would report ` +
              `the turn before it. The text was delivered; \`actana session logs ${taskId}\` shows it`,
          );
        }
      } catch (err) {
        session.dispose();
        throw err;
      }
    }

    return wrap(session, {
      projectId: task?.projectId ?? "",
      project: project?.name ?? null,
      harness: task?.agent ?? null,
      afterEventId,
    });
  }

  /** Start a Session, translating the SDK's refusal into a gateway error. */
  private async begin(opts: {
    projectId?: string;
    taskId?: string;
    cwd: string;
    harness: CoreLinkPtySpawnHarness;
    title?: string;
    command?: string;
    prompt?: string;
    dangerouslySkipPermissions: boolean;
  }): Promise<CoreSession> {
    try {
      return await CoreSession.start(this.client, {
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.command ? { command: opts.command } : {}),
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
        // Sent only when it is true: the Core allow-lists a harness's
        // skip-permissions flag *only* on a spawn that also set this option, so
        // the two travel together or not at all.
        ...(opts.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
        cwd: opts.cwd,
        harness: opts.harness,
      });
    } catch (err) {
      throw new SessionGatewayError("refused", messageOf(err), { cause: err });
    }
  }

  /** The PTY running for this Task, or the reason there is none to act on. */
  private async livePty(taskId: string): Promise<string> {
    const { ptyId } = await this.client.findByTask(taskId);
    if (ptyId === null) {
      throw new SessionGatewayError(
        "not-running",
        `session ${taskId} has no harness running — nothing to read from or write to`,
      );
    }
    return ptyId;
  }

  /**
   * The Task row for a Session, active **or archived**, or null when this Core
   * has neither.
   *
   * Null rather than a refusal, because the caller is a verb that acts on a live
   * PTY and reads this row only for two display fields. `resume` still uses
   * {@link findTask}, where a missing row is genuinely the end of the road: it
   * needs the harness and the recorded session id to start anything at all.
   *
   * The archived list is asked only when the active one did not have it, so the
   * ordinary path still costs one round trip.
   */
  private async findAnyTask(taskId: string): Promise<CoreLinkTaskSnapshot | null> {
    const { tasks } = await this.client.tasksList();
    const active = tasks.find((row) => row.taskId === taskId);
    if (active) return active;
    const archived = await this.client.archivedTasksList();
    return archived.find((row) => row.taskId === taskId) ?? null;
  }

  private async findTask(taskId: string): Promise<CoreLinkTaskSnapshot> {
    const { tasks } = await this.client.tasksList();
    const task = tasks.find((row) => row.taskId === taskId);
    if (!task) {
      throw new SessionGatewayError("no-such-session", `this Core has no session ${taskId}`);
    }
    return task;
  }

  private async projectFor(projectId: string): Promise<CoreLinkProjectSnapshot> {
    const projects = await this.client.projectsList();
    const project = projects.find((row) => row.projectId === projectId);
    if (!project) {
      throw new SessionGatewayError(
        "no-such-project",
        `this Core no longer has the project ${projectId} that session belongs to`,
      );
    }
    return project;
  }

  /**
   * A Project by id, or by name.
   *
   * By id first, because an id is unambiguous and a name is what somebody types.
   * A name matching two Projects is an error rather than a coin toss: starting a
   * Session in the wrong repository is not a mistake a person notices quickly.
   */
  private resolveProject(
    projects: CoreLinkProjectSnapshot[],
    wanted: string,
  ): CoreLinkProjectSnapshot {
    const byId = projects.find((project) => project.projectId === wanted);
    if (byId) return byId;

    const byName = projects.filter((project) => project.name === wanted);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      throw new SessionGatewayError(
        "no-such-project",
        `"${wanted}" names ${byName.length} projects on this Core — use the project id: ${byName
          .map((project) => project.projectId)
          .join(", ")}`,
      );
    }
    const known = projects.map((project) => project.name).join(", ");
    throw new SessionGatewayError(
      "no-such-project",
      known.length > 0
        ? `this Core has no project "${wanted}". It has: ${known}`
        : `this Core has no projects registered`,
    );
  }
}

/**
 * Present one `CoreSession` as a {@link StartedSession}.
 *
 * `harness` is passed in rather than read off the Session: a spawn knows it
 * because it asked for it, and an attach reads it off the Task row — the Core
 * publishes no harness for a PTY that is already running, and `CoreSession` says
 * so with `null` rather than guessing. Same for `command` and `reportsTurnStart`,
 * which are answers to a `spawn` frame and stay null on the attach path.
 *
 * `afterEventId` is the delivery stamp the wait counts from, and 0 — no cursor —
 * is the spawn path and the bare `session wait`.
 */
function wrap(
  session: CoreSession,
  opts: {
    projectId: string;
    project: string | null;
    harness: string | null;
    afterEventId?: number;
  },
): StartedSession {
  const afterEventId = opts.afterEventId ?? 0;
  return {
    taskId: session.taskId,
    ptyId: session.ptyId,
    harness: opts.harness,
    command: session.command,
    reportsTurnStart: session.reportsTurnStart,
    projectId: opts.projectId,
    project: opts.project,
    wait: async (waitOpts) => {
      const idle = await session.waitForTurnEnd({
        ...(afterEventId > 0 ? { afterEventId } : {}),
        ...(waitOpts.timeoutMs ? { timeoutMs: waitOpts.timeoutMs } : {}),
      });
      return {
        status: idle.status,
        exited: idle.exited,
        ...(idle.exitCode === undefined ? {} : { exitCode: idle.exitCode }),
      };
    },
    screen: () => session.screen(),
    dispose: () => session.dispose(),
  };
}

/**
 * The Project's remembered harness, when it names one this build knows.
 *
 * A Core fact (ADR 0017), so the CLI reads it rather than keeping its own
 * default per Project. An unrecognised value falls through to
 * {@link DEFAULT_HARNESS} rather than being sent — a Core that remembers a
 * harness this build has never heard of is a Core to update, not a spawn to
 * fail.
 */
function rememberedHarness(project: CoreLinkProjectSnapshot): CoreLinkPtySpawnHarness | null {
  if (!project.rememberHarnessSettings) return null;
  const saved = project.savedHarness;
  return saved !== null && isKnownHarness(saved) ? saved : null;
}

/**
 * A Task title from the prompt, because "SDK session" — the SDK's own default —
 * is not a title anybody can pick out of `session ls`.
 *
 * First line, trimmed, and short enough to sit in a table column. A Session
 * started with no prompt gets a neutral name rather than an empty cell.
 */
function titleFor(prompt: string | undefined): string {
  const firstLine = (prompt ?? "").split("\n").map((line) => line.trim()).find(Boolean);
  if (firstLine === undefined) return "actana session";
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
