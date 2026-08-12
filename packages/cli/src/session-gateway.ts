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
import { CoreSession, HARNESS_LAUNCH_COMMANDS } from "@actana/sdk/core-session.ts";
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

/** A Session this invocation started, still connected. */
export type StartedSession = {
  taskId: string;
  ptyId: string;
  harness: CoreLinkPtySpawnHarness;
  /** The command the Core was asked to run, after defaulting. */
  command: string;
  projectId: string;
  /** The Project's name, when the start resolved one. */
  project: string | null;
  /**
   * Block until the Core reports this Session settled.
   *
   * The SDK's wait, which is the Core's event log — see rule 3 in the header.
   * `timeoutMs` is a deadline the *operator* asked for (`--wait-timeout`) and
   * its expiry is an error, never a status invented here.
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

/** Everything the `session` noun asks of a Core, and nothing else. */
export type SessionGateway = {
  /** `null` lists every Project's Sessions; a string filters by Project name or id. */
  list(project: string | null): Promise<SessionRow[]>;
  start(request: SessionStartRequest): Promise<StartedSession>;
  resume(request: SessionResumeRequest): Promise<StartedSession>;
  logs(taskId: string): Promise<SessionLogs>;
  /** Write text to a running Session, verbatim. Resolves false if the Core declined. */
  send(taskId: string, text: string): Promise<boolean>;
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
    return wrap(session, project.projectId, project.name);
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
    return wrap(session, project.projectId, project.name);
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

  async send(taskId: string, text: string): Promise<boolean> {
    const ptyId = await this.livePty(taskId);
    // Verbatim, and that is the whole verb. See rule 1: nothing is appended,
    // nothing is timed, nothing is retried.
    return this.client.write(ptyId, text);
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

/** Present one `CoreSession` as a {@link StartedSession}. */
function wrap(session: CoreSession, projectId: string, project: string | null): StartedSession {
  return {
    taskId: session.taskId,
    ptyId: session.ptyId,
    harness: session.harness,
    command: session.command,
    projectId,
    project,
    wait: async (opts) => {
      const idle = await session.waitForIdle(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {});
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
