// session — launching, driving, reading and ending harness sessions.

import { randomUUID } from "node:crypto";

import { UsageError } from "../args.ts";
import type { Ctx } from "../args.ts";
import { delay, trace } from "../client.ts";
import type { CoreClient } from "../client.ts";
import type { Harness, Project, Session, SpawnOptions, Task } from "../protocol.ts";
import { renderTerminal } from "../terminal.ts";
import { findProject } from "./project.ts";

const COLS = 120;
const ROWS = 32;

/**
 * The canonical binary per harness — the Core matches argv[0] against exactly
 * this and rejects anything else with `command-not-on-allowlist`. Only
 * `cursor-cli` differs from its own id, which is why it was the only harness
 * that could not launch.
 *
 * LOCAL STOPGAP for actana/control#177. Delete when the proper fix lands.
 */
const HARNESS_COMMAND: Record<Harness, string> = {
  "claude-code": "claude",
  codex: "codex",
  "cursor-cli": "cursor-agent",
  opencode: "opencode",
};

/**
 * The auto-mode flag per harness. The spawn *option* alone does not put a
 * harness in auto mode — the Core only rejects a flag without the option, never
 * an option without the flag, so a missing flag here launches interactive while
 * the client believes it is unattended. OpenCode has no such flag.
 *
 * LOCAL STOPGAP for actana/control#177. Delete when the proper fix lands.
 */
const HARNESS_AUTO_FLAG: Partial<Record<Harness, string>> = {
  "claude-code": "--dangerously-skip-permissions",
  codex: "--yolo",
  "cursor-cli": "--force",
};

/** Accept either a pty id or a task id wherever a session is named. */
export async function resolvePty(client: CoreClient, ref: string): Promise<string | null> {
  if (ref.startsWith("pty-")) return ref;
  return await client.call<string | null>("findByTask", { taskId: ref });
}

async function livePtyOrThrow(client: CoreClient, ref: string): Promise<string> {
  const ptyId = await resolvePty(client, ref);
  if (!ptyId) throw new Error(`${ref} has no live PTY`);
  return ptyId;
}

/**
 * Type text into a session and submit it.
 *
 * The Enter goes in a *separate* write, after a pause. Claude Code treats a
 * burst of input as a paste rather than typing, and a carriage return in the
 * same frame is swallowed into that block — the TUI shows
 * `[Pasted text #1 +1 lines]` and sits there waiting, because as far as it is
 * concerned you have not pressed Enter yet. Splitting the two makes the return
 * a keystroke against an already-pasted buffer, which submits.
 *
 * The pause scales with length: a long paste takes the TUI longer to ingest,
 * and an Enter that lands mid-ingest is swallowed the same way.
 */
export async function typeInto(
  client: CoreClient,
  ptyId: string,
  text: string,
  { enter = true } = {},
): Promise<void> {
  await client.call<boolean>("write", { ptyId, data: text });
  if (!enter) return;
  await delay(Math.min(1500, 250 + text.length / 4));
  await client.call<boolean>("write", { ptyId, data: "\r" });
}

/** What `start` accumulates while a session boots, so it can tell what is on
 *  screen and when the painting has stopped. */
export type StreamState = { sawData: boolean; lastAt: number; buffer: string };

export function newStreamState(): StreamState {
  return { sawData: false, lastAt: 0, buffer: "" };
}

/** Enough to hold a boot screen; older bytes cannot still be on screen. */
const BUFFER_CAP = 256 * 1024;

export function recordOutput(state: StreamState, data: string): void {
  state.sawData = true;
  state.lastAt = Date.now();
  state.buffer = (state.buffer + data).slice(-BUFFER_CAP);
}

/**
 * One session's slice of the connection's output.
 *
 * Every PTY on the Core shares a single link, and the Core sends `data` frames
 * for all of them, so a handler that ignores the ptyId records other sessions'
 * bytes as if they were its own. That is not cosmetic: the settle detector is
 * waiting for a *gap* in the output, and a second session launched while the
 * first one is working never sees one — it stalls for the full length of every
 * timeout and only then delivers its prompt. The dialog matcher, meanwhile,
 * ends up reading two sessions' bytes interleaved.
 *
 * The subscription has to exist before the spawn so nothing is missed, but the
 * ptyId only arrives with the spawn reply. Frames that turn up in between are
 * held per PTY, and the one that turns out to be ours is adopted after.
 */
export class PtyStream {
  readonly state = newStreamState();
  private ptyId: string | null = null;
  private held = new Map<string, string>();
  private mirror: ((data: string) => void) | null;

  constructor(mirror?: (data: string) => void) {
    this.mirror = mirror ?? null;
  }

  /** True once we know our ptyId and this frame belongs to it. */
  isOurs(id: string): boolean {
    return this.ptyId !== null && id === this.ptyId;
  }

  accept(id: string, data: string): void {
    if (this.ptyId === null) {
      this.held.set(id, ((this.held.get(id) ?? "") + data).slice(-BUFFER_CAP));
      return;
    }
    if (id !== this.ptyId) return;
    recordOutput(this.state, data);
    this.mirror?.(data);
  }

  adopt(ptyId: string): void {
    this.ptyId = ptyId;
    const early = this.held.get(ptyId);
    this.held.clear();
    if (early) {
      recordOutput(this.state, early);
      this.mirror?.(early);
    }
  }
}

/**
 * Blocking dialogs Claude Code opens before it will accept a prompt, and the
 * key that clears each.
 *
 * These are the reason a launched session can look alive and ignore
 * everything, or die on the spot. The bypass-permissions warning is the
 * dangerous one: its highlighted default is "No, exit", so a prompt's Enter
 * quits Claude instead of submitting. Both are recorded per directory in the
 * Core's home volume, so they appear once per project per Core — which is
 * exactly often enough to keep surprising you.
 *
 * Matching happens against the *rendered* screen, not the raw bytes: a TUI
 * writes the spaces between words as cursor moves, so "Yes, I accept" does not
 * appear literally in the stream.
 */
const STARTUP_DIALOGS: { name: string; seen: (screen: string) => boolean; key: string }[] = [
  {
    name: "bypass-permissions",
    seen: (s) => /Bypass Permissions mode/i.test(s) && /Yes, I accept/i.test(s),
    key: "2",
  },
  {
    name: "folder-trust",
    seen: (s) => /trust/i.test(s) && /Yes, I trust this folder/i.test(s),
    key: "1",
  },
];

/**
 * Cells that change on their own, without the screen meaning anything new.
 *
 * A Claude Code TUI at rest is not silent: the spinner glyph cycles and the
 * "(3s · esc to interrupt)" counter ticks, so bytes arrive forever. Waiting for
 * a gap in the output therefore never succeeds — it waits out the whole timeout
 * on every launch and looks like a hang. Waiting for the *rendered screen* to
 * stop changing is the signal that was actually wanted, and these are what has
 * to be ignored for two frames of it to compare equal.
 */
const RESTLESS = /[·✢✳∗✻✽⠁-⠿◐◓◑◒]|\d+/g;

function normalizeScreen(screen: string): string {
  return screen.replace(RESTLESS, "").replace(/[ \t]+/g, " ").trim();
}

/** The screen as it would be seen right now. */
function currentScreen(state: StreamState): string {
  return renderTerminal(state.buffer, COLS, ROWS).join("\n");
}

/**
 * Wait until the TUI has settled: the same screen, ignoring the restless cells,
 * across consecutive samples.
 *
 * Returns false on timeout. Callers carry on regardless — a prompt typed into a
 * busy screen is recoverable, a prompt never typed is not.
 */
async function waitForSettled(
  state: StreamState,
  { sampleMs = 500, stableSamples = 2, timeoutMs = 15_000 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let previous: string | null = null;
  let matches = 0;

  for (;;) {
    await delay(sampleMs);
    if (state.sawData) {
      const screen = normalizeScreen(currentScreen(state));
      if (previous !== null && screen === previous) {
        if (++matches >= stableSamples) return true;
      } else {
        matches = 0;
      }
      previous = screen;
    }
    if (Date.now() >= deadline) return false;
  }
}

/**
 * Answer the startup dialogs, so "auto mode" actually means unattended.
 *
 * Runs whether or not there is a prompt: a session left sitting on one of
 * these accepts no input at all, and would look simply broken.
 */
export async function clearStartupDialogs(
  client: CoreClient,
  ptyId: string,
  state: StreamState,
  { timeoutMs = 20_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    if (!(await waitForSettled(state, { timeoutMs: remaining }))) return;

    const screen = currentScreen(state);
    const dialog = STARTUP_DIALOGS.find((d) => d.seen(screen));
    if (!dialog) return;

    console.error(`[answering ${dialog.name} dialog]`);
    await client.call<boolean>("write", { ptyId, data: dialog.key });
    await delay(200);
    await client.call<boolean>("write", { ptyId, data: "\r" });

    // The answer repaints the screen. Drop what was matched so the same dialog
    // cannot match twice, and wait for the repaint to settle before looking
    // again — dialogs can follow one another.
    state.buffer = "";
    state.lastAt = Date.now();
    if (Date.now() >= deadline) return;
  }
}

/**
 * Type a prompt into a freshly spawned session, once it is ready to receive it.
 *
 * "Ready" is inferred from the output stream rather than a fixed delay: a TUI
 * booting redraws continuously, so the first gap in the data frames is the
 * point where it has finished painting and is waiting on the user. A fixed
 * sleep cannot work here — the boot takes as long as it takes, and guessing
 * short is exactly why the Core's own `initialInput` loses the prompt.
 */
async function deliverPrompt(
  client: CoreClient,
  ptyId: string,
  prompt: string,
  state: StreamState,
  { timeoutMs = 15_000 } = {},
): Promise<void> {
  if (!(await waitForSettled(state, { timeoutMs }))) {
    console.error(`[the TUI never settled in ${timeoutMs / 1000}s — sending the prompt anyway]`);
  }
  await typeInto(client, ptyId, prompt);
}

/**
 * The claude launch command.
 *
 * The Core re-validates every argv element against a per-harness allow-list, so
 * this has to be built exactly, not improvised:
 *   • argv[0] must be the harness's canonical binary — `claude`
 *   • allowed flags: --bare, --session-id, --resume, --model,
 *     --dangerously-skip-permissions
 *   • no shell metacharacters anywhere in argv
 *   • --dangerously-skip-permissions in the string REQUIRES the matching spawn
 *     option, or the Core rejects the spawn
 */
export function buildClaudeCommand(mode: {
  sessionId?: string;
  resume?: string;
  model?: string;
  bare?: boolean;
  skipPermissions?: boolean;
}): { command: string; sessionId: string } {
  const sessionId = mode.resume ?? mode.sessionId ?? randomUUID();
  const parts = ["claude"];
  if (mode.bare) parts.push("--bare");
  parts.push(mode.resume ? "--resume" : "--session-id", sessionId);
  if (mode.model) parts.push("--model", mode.model);
  if (mode.skipPermissions) parts.push("--dangerously-skip-permissions");
  return { command: parts.join(" "), sessionId };
}

async function startSession(
  client: CoreClient,
  opts: {
    projectId: string;
    cwd: string;
    title: string;
    harness: Harness;
    model?: string;
    skipPermissions: boolean;
  },
): Promise<{ taskId: string; ptyId: string }> {
  const task = await client.call<Task | null>("tasksMutate", {
    mutation: { op: "create", projectId: opts.projectId, title: opts.title, agent: opts.harness },
  });
  if (!task) throw new Error("the Core refused to create the task");

  // PTYs outlive any client, and re-spawning a live session fails with
  // "session id already in use".
  const existing = await client.call<string | null>("findByTask", { taskId: task.taskId });
  if (existing) return { taskId: task.taskId, ptyId: existing };

  const { command } = buildClaudeCommand({ model: opts.model, skipPermissions: opts.skipPermissions });

  // No `initialInput`. The Core writes it 450ms after spawn, and Claude Code's
  // TUI is not accepting input that early — the text lands nowhere and the
  // prompt is silently lost. `deliverPrompt()` does it instead.
  const spawnOpts: SpawnOptions = {
    taskId: task.taskId,
    cwd: opts.cwd,
    command:
      opts.harness === "claude-code"
        ? command
        : [
            HARNESS_COMMAND[opts.harness],
            ...(opts.model ? ["--model", opts.model] : []),
            ...(opts.skipPermissions && HARNESS_AUTO_FLAG[opts.harness]
              ? [HARNESS_AUTO_FLAG[opts.harness]!]
              : []),
          ].join(" "),
    cols: COLS,
    rows: ROWS,
    agent: opts.harness,
    dangerouslySkipPermissions: opts.skipPermissions,
  };

  const spawned = await client.request("spawn", { opts: spawnOpts });
  return { taskId: task.taskId, ptyId: String(spawned.ptyId) };
}

async function list(client: CoreClient, all: boolean): Promise<void> {
  // A session is live exactly when it still has a ptyId; finished ones keep
  // their row with ptyId null, so they are filtered out by default.
  const sessions = await client.call<Session[]>("sessionsList");
  const tasks = await client.call<Task[]>("tasksList");
  const byTask = new Map(tasks.map((t) => [t.taskId, t]));
  const rows = sessions.filter((s) => all || s.ptyId);
  if (!rows.length) {
    console.log(all ? "(no sessions)" : "(nothing running — add --all to include finished sessions)");
    return;
  }
  console.log(`${"PTY".padEnd(22)} ${"TASK".padEnd(20)} ${"STATUS".padEnd(10)} HARNESS  TITLE`);
  for (const s of rows) {
    const task = byTask.get(s.taskId);
    console.log(
      `${(s.ptyId ?? "—").padEnd(22)} ${s.taskId.padEnd(20)} ${s.status.padEnd(10)} ` +
        `${(task?.agent ?? "?").padEnd(12)} ${task?.title ?? ""}`,
    );
  }
}

async function start(client: CoreClient, ctx: Ctx, ref: string, prompt?: string): Promise<void> {
  const project = await findProject(client, ref);
  const harness = (ctx.flag("harness") ?? "claude-code") as Harness;
  // Auto mode is the default, matching the Panel: every harness that has such a
  // flag launches with it. The command string and the spawn option must agree,
  // so this single value feeds both.
  const skipPermissions = !ctx.has("ask-permissions");
  const follow = ctx.has("follow");

  // Installed before the spawn so nothing is missed: it feeds both the settle
  // detector and the dialog matcher, and with --follow mirrors the terminal.
  const pty = new PtyStream(follow ? (data) => process.stdout.write(data) : undefined);
  client.onData = (id, data) => pty.accept(id, data);
  if (follow) {
    ctx.keepOpen = true;
    client.onExit = (id, code) => {
      // Another session ending is not our business.
      if (!pty.isOurs(id)) return;
      console.log(`\n[session exited ${code}]`);
      client.close();
      process.exit(code === 0 ? 0 : 1);
    };
  }

  const { taskId, ptyId } = await startSession(client, {
    projectId: project.projectId,
    cwd: project.path,
    title: ctx.flag("title") ?? prompt?.slice(0, 60) ?? "core-client session",
    harness,
    model: ctx.flag("model"),
    skipPermissions,
  });
  pty.adopt(ptyId);

  // The id exists now, so print it now. The typing below takes seconds, and
  // withholding the one piece of output that proves the session was created is
  // what made a working launch look like a hung command. `$(… start …)` is
  // unaffected: the shell waits for exit either way.
  console.log(taskId);
  console.error(follow ? `[pty ${ptyId}] streaming — ctrl-c detaches, the session keeps running` : `pty ${ptyId}`);

  // Always, prompt or not: a session parked on a startup dialog accepts no
  // input, and the bypass-permissions one quits Claude if anything presses
  // Enter at it.
  await clearStartupDialogs(client, ptyId, pty.state);

  // Fire and forget still, but the prompt has to be typed before this process
  // may exit — a second or two, not the life of the session.
  if (prompt) {
    console.error("[waiting for the TUI to settle, then typing the prompt]");
    await deliverPrompt(client, ptyId, prompt, pty.state);
    console.error("[prompt delivered]");
  }
}

async function logs(client: CoreClient, ctx: Ctx, ref: string, follow = ctx.has("follow")): Promise<void> {
  const ptyId = await resolvePty(client, ref);
  // The scrollback buffer lives with the PTY, so a finished session has nothing
  // left to show — resume it instead.
  if (!ptyId) throw new Error(`${ref} has no live PTY — its buffer is gone; \`session resume\` restarts it`);

  if (follow) {
    ctx.keepOpen = true;
    client.onData = (id, data) => {
      if (id === ptyId) process.stdout.write(data);
    };
    client.onExit = (id, code) => {
      if (id !== ptyId) return;
      console.log(`\n[session exited ${code}]`);
      client.close();
      process.exit(0);
    };
    // Subscribe to data before replaying: a replay issued first would drop
    // everything emitted in between.
    const replay = await client.request("replay", { ptyId });
    process.stdout.write(String(replay.data ?? ""));
    console.error(`\n[attached to ${ptyId}]`);
    return;
  }

  const replay = await client.request("replay", { ptyId });
  const raw = String(replay.data ?? "");
  if (ctx.has("raw")) {
    process.stdout.write(raw);
    return;
  }
  // Geometry has to match the spawn or the wrapping lands in the wrong columns.
  const lines = renderTerminal(raw, Number(ctx.flag("cols") ?? COLS), Number(ctx.flag("rows") ?? ROWS));
  // Blank rows are the unpainted parts of the screen, not content.
  const meaningful = lines.filter((line) => line.trim() !== "");
  const count = Number(ctx.flag("lines") ?? 40);
  console.log(meaningful.slice(-count).join("\n"));
}

async function resume(client: CoreClient, ctx: Ctx, taskId: string): Promise<void> {
  const tasks = await client.call<Task[]>("tasksList");
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) throw new Error(`no such task: ${taskId} (try \`session ls --all\`)`);

  ctx.keepOpen = true;
  const pty = new PtyStream((data) => process.stdout.write(data));
  client.onData = (id, data) => pty.accept(id, data);
  client.onExit = (id, code) => {
    if (!pty.isOurs(id)) return;
    console.log(`\n[session exited ${code}]`);
    client.close();
    process.exit(0);
  };

  // Still alive? Then resume means re-attach — spawning a second PTY for the
  // same session id fails with "already in use".
  const live = await client.call<string | null>("findByTask", { taskId });
  if (live) {
    pty.adopt(live);
    const replay = await client.request("replay", { ptyId: live });
    process.stdout.write(String(replay.data ?? ""));
    console.error(`\n[already running — attached to ${live}]`);
    return;
  }

  if (task.agent !== "claude-code") throw new Error(`resume is claude-code only; this task runs ${task.agent}`);
  if (!task.claudeSessionId) {
    throw new Error(
      `task ${taskId} never recorded a harness session id — there is no conversation to resume, start a fresh session`,
    );
  }
  const projects = await client.call<Project[]>("projectsList");
  const project = projects.find((p) => p.projectId === task.projectId);
  if (!project) throw new Error(`task ${taskId} belongs to a project that no longer exists`);

  const skipPermissions = !ctx.has("ask-permissions");
  const { command } = buildClaudeCommand({
    resume: task.claudeSessionId,
    model: ctx.flag("model"),
    skipPermissions,
  });
  const spawned = await client.request("spawn", {
    opts: {
      taskId,
      cwd: project.path,
      command,
      cols: COLS,
      rows: ROWS,
      agent: "claude-code",
      dangerouslySkipPermissions: skipPermissions,
    },
  });
  const resumedPty = String(spawned.ptyId);
  pty.adopt(resumedPty);
  console.error(`[resumed ${task.claudeSessionId} — pty ${resumedPty}]`);
  await clearStartupDialogs(client, resumedPty, pty.state);
}

export async function run(client: CoreClient, ctx: Ctx): Promise<void> {
  const [verb, ...args] = ctx.positional;

  switch (verb) {
    case "ls":
    case undefined:
      await list(client, ctx.has("all"));
      return;

    case "start":
      if (!args[0]) throw new UsageError("session start needs a project", "session");
      await start(client, ctx, args[0], args[1]);
      return;

    case "logs":
      if (!args[0]) throw new UsageError("session logs needs a session", "session");
      await logs(client, ctx, args[0]);
      return;

    case "attach":
      // attach is logs that keeps streaming.
      if (!args[0]) throw new UsageError("session attach needs a session", "session");
      await logs(client, ctx, args[0], true);
      return;

    case "send": {
      if (!args[0] || args.length < 2) throw new UsageError("session send needs a session and text", "session");
      const ptyId = await livePtyOrThrow(client, args[0]);
      const text = args.slice(1).join(" ");
      const enter = !ctx.has("no-enter");
      trace(`send: pty ${ptyId}, ${text.length} chars, enter=${enter}`);

      // Wait for the screen to hold still first. A `send` issued straight after
      // `start` otherwise lands while the TUI is still painting, and text typed
      // then goes nowhere — the failure this two-step flow exists to make
      // visible. `--now` skips it for an interactive session known to be idle.
      if (!ctx.has("now")) {
        const pty = new PtyStream();
        client.onData = (id, data) => pty.accept(id, data);
        pty.adopt(ptyId);
        // Seed from the replay so there is a screen to compare against. An idle
        // Claude emits nothing at all — with no seed there is no first sample,
        // and waiting for one would burn the whole timeout on a session that
        // was ready before we asked.
        const replay = await client.request("replay", { ptyId });
        recordOutput(pty.state, String(replay.data ?? ""));
        trace(`send: seeded ${pty.state.buffer.length}B of replay, waiting for the screen to settle`);
        if (!(await waitForSettled(pty.state, { timeoutMs: 15_000 }))) {
          console.error("[the TUI never settled in 15s — typing anyway]");
        }
        trace("send: settled");
      }

      trace("send: typing");
      await typeInto(client, ptyId, text, { enter });
      trace("send: typed");
      console.log(enter ? "sent" : "typed (not submitted — `session enter` submits it)");
      return;
    }

    case "enter": {
      // Just the keystroke — for a session sitting on an unsubmitted paste or a
      // dialog waiting to be confirmed.
      if (!args[0]) throw new UsageError("session enter needs a session", "session");
      const ptyId = await livePtyOrThrow(client, args[0]);
      await client.call<boolean>("write", { ptyId, data: "\r" });
      console.log("sent");
      return;
    }

    case "interrupt": {
      // Escape — stops whatever Claude is doing and hands the prompt back. Not
      // `kill`: the session stays up and keeps its conversation.
      if (!args[0]) throw new UsageError("session interrupt needs a session", "session");
      const ptyId = await livePtyOrThrow(client, args[0]);
      await client.call<boolean>("write", { ptyId, data: "\x1b" });
      console.log("interrupted");
      return;
    }

    case "resume":
      if (!args[0]) throw new UsageError("session resume needs a task id", "session");
      await resume(client, ctx, args[0]);
      return;

    case "kill":
    case "rm": {
      if (!args[0]) throw new UsageError(`session ${verb} needs a session`, "session");
      const ptyId = await resolvePty(client, args[0]);
      if (!ptyId) {
        console.log("not running");
        return;
      }
      console.log((await client.call<boolean>("kill", { ptyId })) ? "killed" : "not running");
      return;
    }

    case "inspect": {
      if (!args[0]) throw new UsageError("session inspect needs a task id", "session");
      const tasks = await client.call<Task[]>("tasksList");
      const task = tasks.find((t) => t.taskId === args[0]);
      if (!task) throw new Error(`no such task: ${args[0]}`);
      const ptyId = await resolvePty(client, task.taskId);
      console.log(JSON.stringify({ ...task, ptyId }, null, 2));
      return;
    }

    default:
      throw new UsageError(`unknown verb: session ${verb}`, "session");
  }
}
