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
import {
  SESSION_PROMPT_ABANDONED_EVENT_KIND,
  SESSION_PROMPT_DELIVERED_EVENT_KIND,
  type CoreLinkEvent,
  type CoreLinkProjectSnapshot,
  type CoreLinkPtySpawnHarness,
  type CoreLinkSessionLockState,
  type CoreLinkSessionPromptAbandonedPayload,
  type CoreLinkTaskSnapshot,
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
  /**
   * Did the Core give up on delivering this Session's starting prompt (#483)?
   *
   * `null` while nothing says otherwise, which is the ordinary case and also
   * the honest answer on a connection that hung up before the Core decided —
   * delivery runs on the Core's clock and a `start` without `--wait` is gone
   * long before it (#129 D6).
   *
   * A reason means the prompt **is not in the harness**. That is a different
   * thing from the `needs-input` it produces, which on its own reads as "the
   * harness stopped to ask something" — the reading that invites a `session
   * send` in reply. There is no question here and no turn to answer: the text
   * has to go again.
   */
  promptAbandoned(): { reason: string } | null;
  /**
   * Block until the Core says what became of this Session's starting prompt
   * (#395).
   *
   * The readiness gate `session start` never had. A start returns as soon as
   * the Core has the Session running (#129 D6), which is well before the
   * harness can take a keystroke: the composer is not up, the trust dialog may
   * not even have been drawn yet, and a `session send` at that moment lands in
   * a buffer that discards it — taking the starting prompt with it. This waits
   * for the Core's own verdict on the prompt, and the verdict is the readiness:
   * a harness that took the text is a harness that is listening.
   *
   * **It waits on the Core, and adds no timing of its own.** Nothing here
   * polls, nudges, retries or measures how quiet the output went — #191 deleted
   * the last thing that did, and only the Core sees the screen (ADR 0026). The
   * wait ends when the Core says `delivered`, when it says `abandoned` at its
   * own per-harness ceiling (#483), or when the connection carrying those
   * answers goes down.
   */
  awaitPromptDelivery(): Promise<PromptDeliveryReport>;
  /** Release the listeners this Session holds. The harness keeps running. */
  dispose(): void;
};

/**
 * What the Core said about a starting prompt, or why it did not get to say.
 *
 * Four outcomes and not two, because the two that are not the Core's verdict
 * have to stay distinguishable from it. `unavailable` is **not** a failed
 * delivery: the prompt may well have landed a second later, and reporting it as
 * a loss would be the same false report #483 removed, pointed the other way. It
 * is this side saying it stopped being able to hear.
 */
export type PromptDeliveryReport =
  /** The Core typed the prompt into the composer and submitted it. */
  | { outcome: "delivered" }
  /** The Core gave up. The harness is running and has never seen the text. */
  | { outcome: "abandoned"; reason: string }
  /** No verdict was heard, and this side says which of its own limits stopped it. */
  | { outcome: "unavailable"; reason: string };

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
 *
 * **The client must arrive unsubscribed, and this is where that stays true.**
 * A fresh, non-durable `CoreClient` per gateway is what lets
 * {@link openPromptDeliveryLatch} own the `subscribe` and therefore trust the
 * `eventsReplayed` marker it floors on; a shared or already-subscribed client
 * would leave that latch with no floor and no way to tell a replayed row from a
 * live one. It says so itself rather than answering wrongly, but the answer it
 * gives is "I cannot tell", and nobody wants that answer (#487 review,
 * observation a).
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

    const { session, latch } = await this.begin({
      projectId: project.projectId,
      cwd: request.cwd ?? project.path,
      harness,
      title: request.title ?? titleFor(request.prompt),
      prompt: request.prompt,
      dangerouslySkipPermissions: request.dangerouslySkipPermissions,
    });
    return wrap(session, {
      latch,
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
    const { session, latch } = await this.begin({
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
      latch,
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
    // First of all, and before any question has been asked of the Core: the
    // #483 latch listens from here, because `CoreSession.attach` subscribes and
    // then spends four round trips before its own listeners exist. See
    // {@link openPromptDeliveryLatch}. Every `throw` below has to close it, or
    // this command leaves a listener on a client it is done with.
    const latch = openPromptDeliveryLatch(this.client);

    // The archived list as a fallback, because a Session can be archived while
    // its harness is still running — and `tasksList` is active rows only by
    // design (ADR 0019). Every other verb that names a live PTY works on such a
    // Session; refusing it here would make `wait` the odd one out over a row
    // this only reads two display fields off.
    let task: CoreLinkTaskSnapshot | null;
    let project: CoreLinkProjectSnapshot | null;
    try {
      task = await this.findAnyTask(taskId);
      project = task === null ? null : await this.projectFor(task.projectId).catch(() => null);
    } catch (err) {
      latch.close();
      throw err;
    }

    let session: CoreSession;
    try {
      session = await CoreSession.attach(this.client, { taskId });
    } catch (err) {
      latch.close();
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
        latch.close();
        session.dispose();
        throw err;
      }
    }

    return wrap(session, {
      latch,
      projectId: task?.projectId ?? "",
      project: project?.name ?? null,
      harness: task?.agent ?? null,
      afterEventId,
    });
  }

  /**
   * Start a Session, translating the SDK's refusal into a gateway error.
   *
   * The #483 latch is opened here rather than by the caller because *here* is
   * before `CoreSession.start` — before the subscribe, before `createTask`, and
   * before the spawn. A latch opened after that resolves has already missed the
   * window a fast abandon lands in. It is handed back unarmed; `wrap` arms it
   * once there is a Task id to bind it to.
   */
  private async begin(opts: {
    projectId?: string;
    taskId?: string;
    cwd: string;
    harness: CoreLinkPtySpawnHarness;
    title?: string;
    command?: string;
    prompt?: string;
    dangerouslySkipPermissions: boolean;
  }): Promise<{ session: CoreSession; latch: PromptDeliveryLatch }> {
    const latch = openPromptDeliveryLatch(this.client);
    try {
      const session = await CoreSession.start(this.client, {
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
      return { session, latch };
    } catch (err) {
      latch.close();
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
 * Watches one Core connection for what became of a Session's starting prompt.
 *
 * Both halves of it, since issue 395: the `session:promptAbandoned` row #483
 * put on the wire, and the `session:promptDelivered` row that is its positive
 * twin. One latch and not two, because the two rows are the two ends of one
 * question and a caller asking "did the prompt land" must not be able to hear
 * one of them and miss the other.
 *
 * **Why the positive row had to exist at all.** #483 could report a loss from
 * the absence of nothing — it waited for a turn to end and read the abandon row
 * if one had come. #395 cannot: it is the *start* return path, and at the
 * moment a `start` returns the Core has not attempted delivery yet. "No abandon
 * row" and "the composer is still not up" are the same silence there, so a
 * command that read the first as evidence of delivery would be claiming a
 * readiness nobody established — which is the defect, not the fix.
 *
 * Three things have to be true for either report to be trustworthy, and the
 * first version of this got two of them wrong (review of PR #487).
 *
 * **1. It has to be listening before anything asks the Core a question.** The
 * event stream opens with `subscribeEvents`, and both `CoreSession.start` and
 * `CoreSession.attach` send one at the top and then spend several round trips —
 * `createTask`/`spawn`, or `findByTask`/`ptySubscribe`/`replay`/`seedStatus` —
 * before their own listeners exist. A latch registered after those resolve is
 * deaf for the whole window, and the window is exactly where a fast abandon
 * lands. So this opens *first* and holds what it hears until it knows which
 * Task and which cursor it is holding it for — the same shape as
 * `CoreSession.start`'s `heldEvents`, and for the same reason.
 *
 * It also sends the `subscribe` itself when nobody has, which is what makes the
 * replay marker below dependable: the marker belongs to a subscribe, and a
 * subscribe this function did not cause is a subscribe whose marker may already
 * be in the past.
 *
 * **2. A row from a previous life is not a report about this command.** The
 * event log is durable and `subscribe` replays it from the beginning, so a
 * Session whose *first* start was abandoned carries that row forever. Latching
 * it would fail a `session send … --wait` that landed perfectly — and `send` is
 * the recovery this feature's own error message recommends, so misreading it is
 * the same false report as the one #483 exists to kill, pointed the other way.
 * Hence the floor: a stamped delivery counts from its own stamp, and everything
 * else counts from `eventsReplayed`, which is the Core saying "everything up to
 * here was already history when you asked".
 *
 * **3. Silence is not a report.** Until the floor is known, nothing is
 * accepted — events are held, not dropped, and re-judged once it is.
 */
type PromptDeliveryLatch = {
  /** Bind the latch to a Task and, for a stamped delivery, to its cursor. */
  arm(opts: { taskId: string; afterEventId: number }): void;
  /** The Core's reason, or `null` while it has not said the prompt was lost. */
  reason(): { reason: string } | null;
  /** Resolve once the Core has said what became of the starting prompt. */
  settled(): Promise<PromptDeliveryReport>;
  /** Release the listeners. The subscription on the Core is the client's. */
  close(): void;
};

function openPromptDeliveryLatch(client: CoreClient): PromptDeliveryLatch {
  let taskId: string | null = null;
  /** The stamp a delivery was recorded at, when this command made one. */
  let cursor = 0;
  let armed = false;
  /** The high-water mark of the replay tail; `null` until the marker lands. */
  let replayedThrough: number | null = null;
  let abandoned: { reason: string } | null = null;
  /** What the Core has said about this prompt, once it has said anything. */
  let report: PromptDeliveryReport | null = null;
  const waiting: Array<(report: PromptDeliveryReport) => void> = [];
  const held: CoreLinkEvent[] = [];

  /** Answer everybody waiting, once, with the first thing the Core said. */
  const conclude = (next: PromptDeliveryReport): void => {
    if (report) return;
    report = next;
    while (waiting.length > 0) waiting.shift()!(next);
  };

  /**
   * The exclusive floor an event has to clear, or `null` while it is unknown.
   *
   * A stamped delivery knows its own floor the moment it is armed and does not
   * have to wait for the marker; it still takes the larger of the two, because
   * a cursor that predates the replay would let history back in.
   */
  const floor = (): number | null => {
    if (cursor > 0) return Math.max(cursor, replayedThrough ?? 0);
    return replayedThrough;
  };

  const consider = (event: CoreLinkEvent): void => {
    if (report) return;
    if (event.taskId !== taskId) return;
    const bar = floor();
    if (bar === null || event.eventId <= bar) return;
    if (event.kind === SESSION_PROMPT_DELIVERED_EVENT_KIND) {
      // Nothing is read out of the payload beyond the fact. The interesting
      // numbers in it — `characters`, `waitedMs` — are for an operator reading
      // `actana events tail`, and a command that decided anything from them
      // would be deciding from a measurement rather than from the Core's own
      // verdict, which is the direction this whole path exists to close.
      conclude({ outcome: "delivered" });
      return;
    }
    try {
      const payload = JSON.parse(event.payload) as CoreLinkSessionPromptAbandonedPayload;
      abandoned = { reason: typeof payload.reason === "string" ? payload.reason : "" };
    } catch {
      // A payload this build cannot parse is still the Core saying it gave up,
      // and the fact is worth more than the sentence.
      abandoned = { reason: "" };
    }
    conclude({ outcome: "abandoned", reason: abandoned.reason });
  };

  const drain = (): void => {
    if (!armed || floor() === null) return;
    while (held.length > 0) consider(held.shift()!);
  };

  // Registered before the subscribe below, so the replay this asks for cannot
  // outrun the listener that is meant to judge it.
  const stopEvents = client.onEvent(({ event }) => {
    if (
      event.kind !== SESSION_PROMPT_ABANDONED_EVENT_KIND &&
      event.kind !== SESSION_PROMPT_DELIVERED_EVENT_KIND
    ) {
      return;
    }
    if (!armed || floor() === null) {
      held.push(event);
      return;
    }
    consider(event);
  });
  const stopReplayed = client.onEventsReplayed(({ lastEventId }) => {
    // The first marker only. It answers "what was already in the log when this
    // command started", and a later one — a reconnect's replay — would move the
    // floor forward over live events this command is entitled to.
    if (replayedThrough === null) replayedThrough = lastEventId;
    drain();
  });
  // The socket went away before the Core said anything. Not a delivery and not
  // an abandon — the Core may well have delivered the prompt a second later —
  // so it settles a waiter without ever touching `abandoned`, whose meaning is
  // "the Core said it gave up" and must stay that.
  //
  // This is also the only unbounded wait on this path that a clock could
  // otherwise be reached for, and reaching for one is barred here for the
  // reason `no-prompt-timing.test.ts` gives: a module on the path from an
  // operator's text to a harness's stdin schedules nothing. It does not need
  // to. The wait ends on one of the Core's three answers — delivered,
  // abandoned at its own per-harness ceiling (ADR 0026, #483), or the row
  // `pty-manager` appends when the PTY dies mid-delivery — or on this, the
  // connection carrying them going down.
  const stopDisconnected = client.onDisconnected(({ error }) => {
    conclude({
      outcome: "unavailable",
      reason: error
        ? `the connection to the Core went down (${error})`
        : "the connection to the Core went down",
    });
  });
  // The subscribe this latch depends on. `CoreSession.start`/`attach` would
  // send one a moment later on the same test, so this is the same single
  // subscribe moved earlier, not a second one.
  //
  // **A client that arrives already subscribed cannot be judged** (#487 review,
  // observation a). The floor below is the `eventsReplayed` marker of a
  // subscribe *this* function caused; without one the marker never comes, the
  // floor is never known, and every row is held for ever. #483 answered that
  // with silence, which reads as "the prompt was fine". A wait cannot: it would
  // hang for as long as the operator let it. So the latch records that it is
  // deaf and says so instead, and `openSessionGateway` — which builds a fresh
  // client per gateway — is where the invariant is kept.
  const floorless = client.isSubscribedToEvents();
  if (!floorless) client.subscribeEvents();
  if (floorless) {
    conclude({
      outcome: "unavailable",
      reason:
        "this Core connection was already subscribed to the event log, so there is no replay " +
        "marker to tell a live report from a replayed one",
    });
  }

  return {
    arm: (opts) => {
      taskId = opts.taskId;
      cursor = opts.afterEventId;
      armed = true;
      drain();
    },
    reason: () => abandoned,
    settled: () =>
      report
        ? Promise.resolve(report)
        : new Promise<PromptDeliveryReport>((resolve) => waiting.push(resolve)),
    close: () => {
      stopEvents();
      stopReplayed();
      stopDisconnected();
      held.length = 0;
      // Nobody is left waiting on a latch this command has finished with. The
      // ordinary path awaits before disposing; this is for the paths that throw.
      conclude({
        outcome: "unavailable",
        reason: "this command stopped listening before the Core said what became of the prompt",
      });
    },
  };
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
 *
 * `latch` is the #483 report — `session:promptAbandoned`, the Core saying the
 * starting prompt never reached the harness. It is **opened by the caller,
 * before the Session exists**, and only armed here: see
 * {@link openPromptDeliveryLatch} for why the ordering is the whole of it. This
 * function still lets no frame, no `CoreSession` and no client escape to the
 * command module.
 */
function wrap(
  session: CoreSession,
  opts: {
    latch: PromptDeliveryLatch;
    projectId: string;
    project: string | null;
    harness: string | null;
    afterEventId?: number;
  },
): StartedSession {
  const afterEventId = opts.afterEventId ?? 0;
  // Now — and not before — both halves of the filter are known: which Task the
  // report has to be about, and which events are this command's rather than a
  // previous start's.
  opts.latch.arm({ taskId: session.taskId, afterEventId });
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
    promptAbandoned: () => opts.latch.reason(),
    awaitPromptDelivery: () => opts.latch.settled(),
    dispose: () => {
      opts.latch.close();
      session.dispose();
    },
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
