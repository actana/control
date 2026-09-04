import log from "@actana/shared/log";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getAppTheme } from "./app-theme";
import { ensureStatuslineTap } from "@actana/shared/statusline-tap";
import { PtyOutputBatcher } from "./pty-output-batch";
import { PtyOutputActivityWatcher, type PtyOutputActivityKind } from "./pty-output-activity";
import { sliceReplayWindow, type PtyReplayWindow } from "./pty-replay-window";
import {
  resolveHarnessCommandMeetingVersion,
  resolveHarnessCommandOnPath,
} from "@actana/shared/harness-cli-resolution";
import {
  resolveShell,
  sanitizedProcessEnv,
  shellArgsForCommand,
} from "@actana/shared/shell-env";
import { loadProjectRoots } from "./project-roots";
import { MAX_TCP_PORT } from "@actana/shared/tcp-port";
import { shortId } from "@actana/shared/short-id";
import {
  reconcileHookTrustFlag,
  resolveSpawnPlan,
  SpawnPolicyError,
  type SpawnRequest,
} from "@actana/shared/pty-spawn-policy";
import { type PtyHookEnv } from "./pty-hook-env";
import {
  HOOK_MISS_LOG_ENV,
  HOOK_TASK_ID_ENV,
  HOOK_TOKEN_ENV,
  HOOK_URL_ENV,
  installHarnessHooks,
} from "./harness-hooks";
import { checkHarnessCliVersionCached, harnessVersionErrorMessage } from "@actana/shared/harness-cli-version";
import {
  HARNESS_CLI_CONFIG,
  HARNESS_CLI_CONFIG_BY_COMMAND,
} from "@actana/shared/harness-cli-version-requirements";
import { applyHarnessPtyEnv } from "@actana/shared/harness-pty-env";
import { acquireSpawnSlot, SPAWN_SETTLE_MS } from "./pty-spawn-queue";
import { HarnessPromptDelivery, type PromptDeliveryEvent } from "./harness-prompt-delivery";

function sanitizeEnv(): Record<string, string> {
  const out = sanitizedProcessEnv();
  // The PTY is xterm.js, not whichever terminal launched the Core. Leaking
  // TERM_PROGRAM=ghostty (or iTerm.app, etc.) makes Claude Code take terminal-
  // specific code paths that don't match what we actually emit — e.g. it skips
  // installing the Shift+Enter keybinding when it thinks Ghostty is handling it
  // natively, but xterm.js sends `\x1b\r` (the iTerm sequence) instead of LF.
  delete out.TERM_PROGRAM;
  delete out.TERM_PROGRAM_VERSION;
  return out;
}

// Claude Code only treats ESC+CR (`\x1b\r`, what `terminal-keymap.ts` emits for
// Shift+Enter) as "insert newline" when this flag is set. Normally `/terminal-
// setup` writes it; do it eagerly so the user doesn't have to.
export function ensureClaudeShiftEnterBinding(): void {
  try {
    const dir = path.join(os.homedir(), ".claude");
    const file = path.join(dir, "settings.json");
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      if (raw.trim()) settings = JSON.parse(raw);
    }
    if (settings.shiftEnterKeyBindingInstalled === true) return;
    settings.shiftEnterKeyBindingInstalled = true;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch {
    // best-effort — user can still run `/terminal-setup` manually.
  }
}

type Pty = {
  id: string;
  taskId: string;
  proc: any;
  buffer: PtyBufferChunk[];
  bufferBytes: number;
  nextSeq: number;
  cwd: string;
  command: string;
  agent?: string;
  /** True for user-shell terminals; findByTask only matches agent PTYs. */
  shell: boolean;
  /**
   * True for VM Shell Sessions (issue 06) — a free-form shell on this Core's
   * machine with no project folder. Like `shell`, findByTask skips it; the
   * Panel renders it with a distinct "VM shell" surface. Gated by core-link
   * auth, not project-root validation.
   */
  shellSession?: boolean;
  /** Last renderer write (user keystroke) — marks the PTY as interactive so
   *  battery saver never throttles typing echo (see pty-output-batch.ts). */
  lastInputAt: number;
};

type PtyBufferChunk = {
  seq: number;
  data: string;
  bytes: number;
};

/** How long after a keystroke a PTY still counts as interactive. */
const PTY_INTERACTIVE_WINDOW_MS = 10_000;

const LSOF_PROBE_TIMEOUT_MS = 2_000;
// Time we'll wait for SIGTERM to take before escalating to SIGKILL (port-kill)
// or before giving up the wait (pty kill). Same grace for both: 1.5s.
const SIGTERM_GRACE_MS = 1_500;
const PORT_KILL_POLL_INTERVAL_MS = 100;
const PTY_EXIT_POLL_INTERVAL_MS = 50;
const TASKKILL_TIMEOUT_MS = 5_000;
const LOG_VALUE_MAX_LENGTH = 160;

function safeLogValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "?");
  return cleaned.length > LOG_VALUE_MAX_LENGTH
    ? `${cleaned.slice(0, LOG_VALUE_MAX_LENGTH)}...`
    : cleaned;
}
const DEFAULT_PTY_COLS = 100;
const DEFAULT_PTY_ROWS = 30;

export function hasClaudeInterruptPrompt(text: string): boolean {
  return (
    text.includes("Interrupted by user") ||
    (text.includes("Interrupted") &&
      text.includes("What should Claude do instead"))
  );
}

export function hasCodexHookReviewPrompt(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").toLowerCase();
  return (
    normalized.includes("hooks need review before they can run") ||
    normalized.includes("open /hooks to review")
  );
}

/** Deliver an output-derived status signal without letting it break the stream. */
function reportOutputSignal(
  deps: PtyCoreDeps,
  taskId: string,
  signal: "interrupted" | "hooks-need-review" | "dialog-unanswered",
): void {
  if (!taskId) return;
  try {
    deps.onSessionOutputSignal?.({ taskId, signal });
  } catch (err) {
    log.warn("pty.output-signal.failed", { signal, error: String(err) });
  }
}

/** Report an abandoned starting prompt without letting the sink break delivery. */
function reportPromptAbandoned(
  deps: PtyCoreDeps,
  info: { taskId: string; ptyId: string; reason: string },
): void {
  if (!info.taskId) return;
  try {
    deps.onSessionPromptAbandoned?.(info);
  } catch (err) {
    log.warn("pty.prompt-abandoned.failed", { error: String(err) });
  }
}

/** Report a delivered starting prompt on the same terms. */
function reportPromptDelivered(
  deps: PtyCoreDeps,
  info: {
    taskId: string;
    ptyId: string;
    characters: number;
    waitedMs: number;
    composerObserved: boolean;
  },
): void {
  if (!info.taskId) return;
  try {
    deps.onSessionPromptDelivered?.(info);
  } catch (err) {
    log.warn("pty.prompt-delivered.failed", { error: String(err) });
  }
}

const ptys = new Map<string, Pty>();
const RING_LIMIT_BYTES = 1_000_000;

/**
 * Dependencies the PTY core needs from its host process.
 */
export type PtyCoreDeps = {
  /** Path to the user-data dir. */
  userDataDir: string;
  /** Path to the app root. */
  appPath: string;
  /** Supplies the MC API URL + token so agent hooks can POST back. */
  getHookEnv: () => PtyHookEnv | null;
  /** Ports the port-kill path must never touch (the runtime's own port). */
  getProtectedPorts: () => Iterable<number | null | undefined>;
  /**
   * A harness PTY exited (issue 84). Called for every agent PTY on every exit
   * — crash, kill, the operator closing the pane — regardless of whether a
   * Panel is connected, because the emit target is null while the link is
   * down and a Session that died then must still settle on this Core.
   */
  onSessionExit?: (info: { taskId: string; exitCode: number }) => void;
  /**
   * A harness's own output said something its hooks do not (issue 84).
   * Claude has no `UserInterrupt` settings hook, and Codex refuses to run
   * newly-installed hooks until the operator reviews them with `/hooks` — the
   * one moment its hooks provably cannot report. Both are read off the PTY
   * stream; each fires once per occurrence, not once per chunk.
   *
   * `dialog-unanswered` is the third and comes from prompt delivery rather
   * than from a pattern in the bytes (issue 177 finding 3): the Core gave up
   * on delivering the starting prompt because a dialog was in its way that it
   * could not answer. ADR 0026 D5 is deliberate that it types nothing in that
   * case — a session parked on a visible dialog is one keystroke from an
   * operator being fine, and one that answered wrongly is gone — but until now
   * the giving-up was a log line on the Core and nothing else. The Session sat
   * at its pre-turn status, and to every client that is indistinguishable from
   * a hang. It is not a hang: it is a harness waiting on a human, which is
   * what `needs-input` means.
   */
  onSessionOutputSignal?: (info: {
    taskId: string;
    signal: "interrupted" | "hooks-need-review" | "dialog-unanswered";
  }) => void;
  /**
   * The Core gave up delivering this Session's starting prompt (issue 483).
   *
   * The status change above is the half every client already renders; this is
   * the half that says *why*, and it exists because the two readings of
   * `needs-input` call for opposite actions. A harness that stopped to ask a
   * question is answered with `session send`. A harness that never received the
   * prompt has no question and no turn, and sending into it answers nothing —
   * the prompt has to go again. Only the Core knows which of the two it is, and
   * before this the answer was a line in its own process log.
   *
   * Optional like its neighbours: a host that wires nothing loses the event and
   * keeps the status, which is exactly the behaviour that shipped before.
   */
  onSessionPromptAbandoned?: (info: {
    taskId: string;
    ptyId: string;
    reason: string;
  }) => void;
  /**
   * The Core **has** delivered this Session's starting prompt (issue 395).
   *
   * The other half of the pair above, and the one a caller has to have if
   * `session start` is ever to stop claiming a readiness it has not
   * established. The absence of an abandon row is not evidence that the prompt
   * landed — it is equally the shape of a delivery still in progress, which is
   * what a `start` sees, because delivery runs on the harness's clock and the
   * client has hung up long before it (#129 D6). This row is the Core saying
   * the harness took the text: composer marker on screen, prompt written, echo
   * confirmed where the harness confirms echo, carriage return gone.
   *
   * **The row is appended in the same synchronous tick as the submit**, from
   * inside `HarnessPromptDelivery.submit`, which is what keeps issue 483's
   * ordering discipline pointed the other way: any status the turn this prompt
   * starts eventually produces is appended to the same log strictly later, so a
   * client that hears the status has already heard the delivery. A reason
   * appended behind the status is a reason nobody reads, and a delivery
   * appended behind it would be no better.
   *
   * Optional like its neighbours: a host that wires nothing loses the event and
   * keeps every behaviour that shipped before.
   */
  onSessionPromptDelivered?: (info: {
    taskId: string;
    ptyId: string;
    characters: number;
    waitedMs: number;
    /** Was a composer seen, or did the quiet gap vouch for it? See issue 395. */
    composerObserved: boolean;
  }) => void;
  /**
   * This Session's harness is still talking (issue 243). Not a status and not
   * a signal — just the fact that bytes arrived, which is what tells a turn
   * that is genuinely running from one that ended without saying so. Throttled
   * to at most one call per five seconds per PTY (`OUTPUT_ACTIVITY_WINDOW_MS`),
   * so a harness redrawing its spinner does not cost a callback per chunk.
   *
   * `kind` is what those bytes were (issue 391): `output` if the burst put
   * something new on screen, `redraw` if it repainted what was already there.
   * A harness whose hooks are not arriving paints its spinner forever, so
   * "bytes arrived" on its own can never end a turn — see
   * `pty-output-activity.ts` and the two rules in `core-session-backstop.ts`.
   */
  onSessionOutputActivity?: (info: { taskId: string; kind: PtyOutputActivityKind }) => void;
};

/** Event emitted by the Core for a PTY — `data` (output) or `exit`. */
export type PtyCoreEvent =
  | { type: "data"; ptyId: string; data: string; seq: number }
  | { type: "exit"; ptyId: string; exitCode: number; signal?: number };

// Module-level state: one Core per process (the Core daemon
// OR the standalone Core process). Set by registerPtyHandlers or
// PtyCore's constructor.
let activeDeps: PtyCoreDeps | null = null;
let emitTarget: ((event: PtyCoreEvent) => void) | null = null;

const outputBatcher = new PtyOutputBatcher((ptyId, data, seq) => {
  emitTarget?.({ type: "data", ptyId, data, seq });
});

type PortKillResult = {
  port: number;
  pids: number[];
  killed: number[];
  errors: string[];
};

type LaunchPortKillTarget = {
  port: number;
  protected: boolean;
};

let nodePty: typeof import("node-pty") | null = null;
function loadNodePty() {
  if (!nodePty) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nodePty = require("node-pty");
  }
  return nodePty!;
}

function appendBuffer(p: Pty, data: string): number {
  const bytes = Buffer.byteLength(data, "utf8");
  const seq = p.nextSeq++;
  p.buffer.push({ seq, data, bytes });
  p.bufferBytes += bytes;
  while (p.bufferBytes > RING_LIMIT_BYTES && p.buffer.length > 1) {
    const dropped = p.buffer.shift()!;
    p.bufferBytes -= dropped.bytes;
  }
  return seq;
}

// The C0 bytes that are whitespace in the source text: tab, line feed,
// vertical tab, form feed, carriage return. They cannot be written through
// verbatim — a bare CR/LF submits the prompt early — but they *separate* the
// words either side of them, so a run of them collapses to one space instead
// of vanishing (issue #193). Dropping them outright welded the last word of a
// line onto the first word of the next: "review the diff\nthen open a PR"
// arrived as "review the diffthen open a PR".
const WHITESPACE_CONTROL_RUN = /[\t\n\v\f\r]+/g;

// A programmatic starting prompt (Ship / Sync / Create-PR) is written to the
// agent's stdin like the user typing. Whitespace control bytes become a single
// space; every other C0/DEL byte is dropped with nothing in its place, so a
// caller can't drive TUI keybindings. The submit CR is added separately.
export function sanitizeInitialInput(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const clean = Array.from(text.replace(WHITESPACE_CONTROL_RUN, " "))
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  return clean || undefined;
}

function sendToEmitTarget(event: PtyCoreEvent): void {
  emitTarget?.(event);
}

function normalizedCommand(command: string): string {
  return command.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * node-pty's `proc.kill()` only signals the immediate shell. On Windows that
 * leaves grandchild processes alive — notably the `node.exe` running Claude
 * Code, which keeps a handle on the workspace's `.claude/` dir and blocks a
 * later delete with "Permission denied". taskkill /T tears down the whole tree
 * so the handles are released first.
 */
function killProcessTreeWindows(pid: number | undefined): void {
  if (os.platform() !== "win32" || !pid || pid <= 0) return;
  try {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      timeout: TASKKILL_TIMEOUT_MS,
    });
  } catch {
    /* best-effort — proc.kill() below is the fallback */
  }
}

/**
 * Fully release a PTY, including the master /dev/ptmx fd that node-pty holds in
 * THIS process.
 *
 * node-pty's `proc.kill()` only sends SIGHUP to the immediate child — it never
 * closes the master fd. If that child survives the signal (a claude/codex agent
 * that re-parented its tool subprocesses, a shell trapping SIGHUP, a stopped
 * job), the slave stays open, the master never sees EIO, and node-pty keeps the
 * master fd open for the life of the app. Every leaked master counts against
 * macOS's system-wide `kern.tty.ptmx_max` (~511), so a long-lived window that
 * churns PTYs (e.g. the warm-session pool re-preparing on every project query
 * refetch) eventually exhausts the cap and makes EVERY pty spawn on the whole
 * machine fail with posix_spawnp/ENXIO.
 *
 * node-pty's `destroy()` is the only method that closes the master socket
 * directly; hanging up the master also makes the kernel SIGHUP the slave's
 * foreground process group, so the fd is reclaimed even when the child won't die
 * on its own. It isn't on the public `IPty` type but exists on both the Unix and
 * Windows terminals at runtime — fall back to `kill()` if a future version drops
 * it. This is the single teardown path; never call `proc.kill()` directly.
 *
 * NOTE: destroy() alone did not stop ptmx exhaustion. node-pty <= 1.1.0 ALSO
 * leaked two fds inside every macOS spawn (a never-closed posix_openpt guard
 * fd and the parent's copy of the slave fd), plus the master on failed spawns
 * — so churn (warm pools) still crept toward the cap, and once near it every
 * failed retry leaked 2-3 more fds until the whole machine couldn't allocate
 * PTYs. Fixed by node-pty 1.2.0-beta.14 (closes slave + guard fds on all
 * paths, master on error). Don't downgrade node-pty below that.
 */
export function disposePty(proc: import("node-pty").IPty | null | undefined): void {
  if (!proc) return;
  // Capture the pid before destroy() so the tree-kill below still has it.
  const pid = proc.pid;
  // Close the pseudoconsole FIRST. node-pty's Windows destroy() runs the ConPTY
  // teardown (ClosePseudoConsole + a final conout-worker dispose) that lets the
  // kernel reap the conhost.exe ConPTY spawned. A pre-destroy `taskkill /F`
  // (the old order) killed the shell out from under that teardown, so the
  // dispose never fired and one conhost.exe (~8.5 MB, parented to our main
  // process) leaked on every create→delete of a terminal.
  const closable = proc as unknown as { destroy?: () => void };
  try {
    if (typeof closable.destroy === "function") {
      closable.destroy();
    } else {
      proc.kill();
    }
  } catch {
    /* already exited or fd already closed */
  }
  // Then, on Windows only (no-op elsewhere), tree-kill any survivors: SIGHUP /
  // console-close doesn't reliably reach a grandchild node.exe that re-parented
  // its tool subprocesses and holds the workspace's .claude/ handle. This runs
  // back-to-back with destroy(), so the shell tree is still intact here.
  killProcessTreeWindows(pid);
}

function pidsListeningOnPort(port: number): number[] {
  if (!Number.isInteger(port) || port <= 0 || port > MAX_TCP_PORT) return [];
  if (os.platform() === "win32") return [];

  const result = spawnSync("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: LSOF_PROBE_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return [];

  const pids = (result.stdout || "")
    .split(/\s+/)
    .map((raw) => Number(raw))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  return [...new Set(pids)];
}

async function killPidsListeningOnPort(port: number): Promise<PortKillResult> {
  const pids = pidsListeningOnPort(port);
  const killed: number[] = [];
  const errors: string[] = [];

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch (err: any) {
      errors.push(`pid ${pid}: ${err?.message ?? String(err)}`);
    }
  }

  if (killed.length > 0) {
    const deadline = Date.now() + SIGTERM_GRACE_MS;
    while (Date.now() < deadline && pidsListeningOnPort(port).some((pid) => killed.includes(pid))) {
      await sleep(PORT_KILL_POLL_INTERVAL_MS);
    }
    for (const pid of pidsListeningOnPort(port).filter((pid) => killed.includes(pid))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already exited or not permitted */
      }
    }
  }

  return { port, pids, killed, errors };
}

function normalizePorts(ports: Iterable<number | null | undefined>): number[] {
  return [
    ...new Set(
      [...ports].filter(
        (port): port is number =>
          typeof port === "number" &&
          Number.isInteger(port) &&
          port > 0 &&
          port <= MAX_TCP_PORT
      )
    ),
  ];
}

export function planLaunchPortKillTargets(
  ports: Iterable<number | null | undefined>,
  protectedPorts: Iterable<number | null | undefined>,
): LaunchPortKillTarget[] {
  const protectedSet = new Set(normalizePorts(protectedPorts));
  return normalizePorts(ports).map((port) => ({
    port,
    protected: protectedSet.has(port),
  }));
}

async function killPty(p: Pty): Promise<boolean> {
  let exited = false;
  try {
    const sub = p.proc.onExit(() => {
      exited = true;
    });
    disposePty(p.proc);
    const deadline = Date.now() + SIGTERM_GRACE_MS;
    while (!exited && Date.now() < deadline) {
      await sleep(PTY_EXIT_POLL_INTERVAL_MS);
    }
    sub?.dispose?.();
    return true;
  } catch {
    return false;
  } finally {
    ptys.delete(p.id);
  }
}

// ─── PtyCore ─────────────────────────────────────────────────────────
//
// Transport-agnostic PTY manager. Owns the PTY map, the output batcher, and all
// spawn/write/resize/kill/replay logic. The standalone Core process wires it
// to a WebSocket server via PtyCoreLinkServer.

let activeCore: PtyCore | null = null;

/** Sets the process-wide core that `killAllPtys` delegates to. */
export function setActivePtyCore(core: PtyCore | null): void {
  activeCore = core;
}

export class PtyCore {
  constructor(private readonly deps: PtyCoreDeps) {
    activeDeps = deps;
  }

  /** Set the sink for data/exit events. Pass null to stop emitting (e.g. on WS disconnect). */
  setEmitTarget(fn: ((event: PtyCoreEvent) => void) | null): void {
    emitTarget = fn;
  }

  async spawn(opts: SpawnRequest): Promise<{ ptyId: string; hooksReportTurnStart: boolean }> {
    // Harness cold-boots are throttled; shells are not. A login shell is cheap
    // and is almost always an explicit gesture by one operator, while a grid of
    // agents arrives all at once and each one is a full Node process.
    const throttled = opts.agent !== undefined && !opts.shell && !opts.shellSession;
    const releaseSlot = throttled ? await acquireSpawnSlot() : null;
    let holdReleased = false;
    const releaseSpawnHold = () => {
      if (holdReleased) return;
      holdReleased = true;
      releaseSlot?.();
    };
    try {
      return await this.spawnUnthrottled(opts, releaseSpawnHold);
    } catch (err) {
      releaseSpawnHold();
      throw err;
    }
  }

  private async spawnUnthrottled(
    opts: SpawnRequest,
    releaseSpawnHold: () => void,
  ): Promise<{ ptyId: string; hooksReportTurnStart: boolean }> {
    const pty = loadNodePty();
    const platform = os.platform();
    const { userDataDir, appPath, getHookEnv } = this.deps;

    // Home shell terminals: the renderer never learns the host's home path, so
    // the handler replaces cwd with its own os.homedir() before the policy's
    // project-root check. VM Shell Sessions (issue 06) use the same trick — a
    // VM shell has no project folder, and the Core's own home is the only
    // sensible place to drop the operator. The policy's `shellSession` branch
    // skips the project-root check entirely regardless of cwd, but supplying
    // the real home here means node-pty gets a valid cwd to chdir into.
    const spawnReq: SpawnRequest =
      opts.shell === true && opts.home
        ? ({ ...opts, cwd: os.homedir() } as SpawnRequest)
        : opts.shellSession === true
          ? ({ ...opts, cwd: opts.cwd || os.homedir() } as SpawnRequest)
          : opts;
    let plan: ReturnType<typeof resolveSpawnPlan>;
    try {
      plan = resolveSpawnPlan(spawnReq, {
        projectRoots: loadProjectRoots,
        homeShellRoots: () => [os.homedir()],
        resolveCommand: (name) => {
          const env = sanitizedProcessEnv();
          const requirement = HARNESS_CLI_CONFIG_BY_COMMAND[name];
          if (requirement) {
            return resolveHarnessCommandMeetingVersion(name, requirement, env, platform)?.binary ?? null;
          }
          return resolveHarnessCommandOnPath(name, env, platform);
        },
        resolveShell: () => ({
          shell: resolveShell(),
          shellArgs: (cmd) => shellArgsForCommand(resolveShell(), cmd, platform),
        }),
      });
    } catch (err) {
      if (err instanceof SpawnPolicyError) {
        log.warn("pty.spawn.rejected", {
          code: err.code,
          agent: safeLogValue(opts.agent ?? null),
          shell: opts.shell === true,
          cwd: safeLogValue(opts.cwd),
          taskId: safeLogValue(opts.taskId),
        });
        throw new Error(`pty:spawn rejected (${err.code})`);
      }
      throw err;
    }

    const env = sanitizeEnv();
    if (plan.mode === "agent") {
      const requirement = HARNESS_CLI_CONFIG[plan.agent];
      const versionCheck = checkHarnessCliVersionCached(plan.binary, env, requirement, platform);
      if (!versionCheck.ok) {
        const message = harnessVersionErrorMessage(versionCheck);
        throw new Error(message);
      }
    }

    // Harness-workspace-only setup; a VM Shell Session (and a plain user shell)
    // has no agent config to touch.
    let hooksReportTurnStart = false;
    if (plan.mode === "agent") {
      if (plan.agent === "claude-code") ensureStatuslineTap(plan.cwd);
      // Lifecycle hooks, pointed at THIS Core's loopback receiver (issue 84).
      // Without them nothing ever moves the Session's status off `ready`. The
      // env carries the URL and token so the file on disk holds no secret and
      // survives a restart that mints a new one; without a hook env there is
      // no receiver to report to, so the install is skipped entirely.
      const hookEnv = getHookEnv();
      // Reconciled below whether or not hooks were installed: a plan that
      // arrived carrying the bypass flag must lose it when this spawn did not
      // earn it, and "no hook receiver, so no file was written" is the
      // clearest case of not earning it (issue 290).
      let hookTrustBypassEarned = false;
      if (hookEnv) {
        const hooks = installHarnessHooks(plan.agent, plan.cwd);
        hooksReportTurnStart = hooks.reportsTurnStart;
        hookTrustBypassEarned = hooks.hookTrustBypassEarned;
        // The env goes in whenever a file landed, even for a family whose
        // hooks do not announce a turn's start: those still report its end,
        // and a `Stop` with no token to present is a Session that never
        // finishes.
        if (hooks.installed) {
          env[HOOK_URL_ENV] = hookEnv.apiUrl;
          env[HOOK_TOKEN_ENV] = hookEnv.token;
          env[HOOK_TASK_ID_ENV] = opts.taskId;
          // Where this Session's hooks record a POST the Core never acked
          // (issue 243). Absent, the command writes to /dev/null and the hook
          // is as fail-soft as it always was — just as invisible when it drops.
          if (hookEnv.missLogPath) env[HOOK_MISS_LOG_ENV] = hookEnv.missLogPath;
        }
      }

      // The harness's own hook-trust review is lifted here, by the process
      // that wrote the hooks, and only for a workspace whose hooks are all
      // ours. No launch command carries this flag — a command is composed
      // before any file lands, by a client that has not seen the workspace —
      // and one that arrives with it anyway is stripped. See
      // `reconcileHookTrustFlag`.
      const reconciled = reconcileHookTrustFlag(plan, hookTrustBypassEarned);
      if (reconciled !== plan) {
        log.info("pty.spawn.hookTrust", {
          agent: safeLogValue(plan.agent),
          taskId: safeLogValue(opts.taskId),
          // `false` here is not a failure: it is the vendor's review left
          // standing over hooks this Core cannot vouch for.
          bypassed: hookTrustBypassEarned,
        });
        plan = reconciled;
      }
    }

    const appTheme =
      getAppTheme() ?? (opts.missionControlTheme === "light" ? "light" : "dark");
    if (plan.mode === "agent") {
      env.COLORFGBG = appTheme === "light" ? "0;15" : "15;0";
    }
    applyHarnessPtyEnv(env, opts.agent);

    // `agent` mode spawns the agent binary directly; `shell` and `shell-session`
    // modes both resolve to the user's login shell (`plan.shellPath`).
    const spawnTarget = plan.mode === "agent" ? plan.spawnTarget : plan.shellPath;
    const spawnArgs = plan.mode === "agent" ? plan.spawnArgs : plan.shellArgs;

    let proc: import("node-pty").IPty;
    try {
      proc = pty.spawn(spawnTarget, spawnArgs, {
        name: "xterm-256color",
        cols: opts.cols ?? DEFAULT_PTY_COLS,
        rows: opts.rows ?? DEFAULT_PTY_ROWS,
        cwd: plan.cwd,
        env,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes("posix_spawnp")) {
        throw new Error(
          `posix_spawnp failed for target="${spawnTarget}" cwd="${plan.cwd}". ` +
            `Verify the binary exists and the cwd is a readable directory. ` +
            `Original: ${msg}`
        );
      }
      throw err;
    }

    const id = shortId("pty");
    const p: Pty = {
      id,
      taskId: opts.taskId,
      proc,
      buffer: [],
      bufferBytes: 0,
      nextSeq: 1,
      cwd: opts.shellSession ? plan.cwd : (opts.cwd ?? plan.cwd),
      command: opts.command ?? "",
      agent: opts.agent,
      shell: opts.shell === true,
      shellSession: opts.shellSession === true,
      lastInputAt: 0,
    };
    ptys.set(id, p);

    // The starting prompt is delivered by the Core, on the harness's own
    // schedule (ADR 0026). Nothing here decides *when* — `harness-prompt-
    // delivery.ts` watches this PTY's output for the TUI to stop painting,
    // answers whatever dialog is in the way, and sends the carriage return as
    // its own keystroke once the paste has settled. The client sent a string
    // and nothing else, whether it was a Panel, the CLI or an SDK automation.
    const initialInput =
      plan.mode === "agent" && !opts.shell && !opts.shellSession
        ? sanitizeInitialInput(opts.initialInput)
        : undefined;
    const promptDelivery =
      initialInput && plan.mode === "agent"
        ? new HarnessPromptDelivery({
            harness: plan.agent,
            prompt: initialInput,
            write: (data) => {
              try {
                proc.write(data);
              } catch {
                /* pty already exited before the starting prompt could be written */
              }
            },
            onEvent: (event: PromptDeliveryEvent) => {
              // Taken whole and destructured here rather than in the parameter
              // list, because the rest of a discriminated union is not narrowed
              // by its own discriminant: `event.phase === "delivered"` gives
              // `event.promptChars` its type, and `detail.promptChars` would
              // have needed a cast that a rename could walk straight through.
              const { phase, ...detail } = event;
              // Delivery gave up with something still on screen.
              //
              // **The reason goes out before the status, and the order is load-
              // bearing** (issue 483, review of PR #487). Both of these append
              // to the same monotonic event log, and the status is the one that
              // *ends a client's wait*: `dialog-unanswered` writes the row
              // through `CoreHarnessStatus` → `needs-input`, whose `task:updated`
              // event resolves `waitForTurnEnd` synchronously on the client. A
              // client that resolved on event N and then read a reason that was
              // only appended as N+1 would report a clean settle for a prompt
              // that never landed — which is the false success this whole issue
              // is about, moved one layer out. Appending the reason first makes
              // it strictly precede the status, so any client that hears the
              // status has already heard the reason. It costs nothing.
              if (phase === "abandoned" && p.taskId) {
                // `reason` is the delivery module's own words — a dialog id it
                // knows, or a composer that never arrived — and it goes through
                // the same cleaner as the log line below, because a payload on
                // the wire deserves at least what a log line gets.
                reportPromptAbandoned(this.deps, {
                  taskId: p.taskId,
                  ptyId: id,
                  reason: String(safeLogValue((detail as { reason?: unknown }).reason ?? "")),
                });
                // Say so as a status and not only in the log (issue 177 finding
                // 3): every client reads the Session's status, and none of them
                // reads this process's log. `needs-input` is what it is — a
                // harness waiting on a human — and it is a settled status, so an
                // SDK `waitForIdle` stops waiting instead of waiting forever.
                reportOutputSignal(this.deps, p.taskId, "dialog-unanswered");
              }
              // And the other outcome, which had no wire at all until issue
              // 395: the prompt reached the harness. Said here rather than
              // inferred anywhere, because "no abandon row yet" is the same
              // silence as "still waiting for the composer", and a `session
              // start` that read the second as the first would be claiming a
              // readiness nobody established — the defect 395 is about.
              //
              // This runs inside `submit`, in the same synchronous tick as the
              // carriage return, so the row is in the log before the event loop
              // can carry a single byte of the harness's reply. Whatever status
              // the turn produces is therefore strictly behind it.
              if (event.phase === "delivered" && p.taskId) {
                reportPromptDelivered(this.deps, {
                  taskId: p.taskId,
                  ptyId: id,
                  characters: event.promptChars,
                  waitedMs: event.waitedMs,
                  // Carried rather than inferred: this Core knows whether it
                  // matched a composer marker or typed on the quiet gap, and no
                  // client can work that out from the outside (issue 395).
                  composerObserved: event.composerObserved,
                });
              }
              // A dialog's label is harness output, so it goes through the same
              // cleaner every other borrowed string in this file does.
              const safe = Object.fromEntries(
                Object.entries(detail).map(([key, value]) => [key, safeLogValue(value)]),
              );
              log.info(`pty.prompt-delivery.${phase}`, {
                taskId: safeLogValue(p.taskId),
                agent: plan.agent,
                ...safe,
              });
            },
          })
        : undefined;

    // First output means the agent is mostly booted — hand the spawn slot to
    // whoever is queued behind it. The timeout is the backstop for an agent
    // that boots silently and would otherwise pin its slot forever.
    const settleTimer = setTimeout(releaseSpawnHold, SPAWN_SETTLE_MS);
    // Latched so a prompt that stays on screen across many output chunks
    // reports once. Re-armed as soon as it is no longer being shown.
    let interruptReported = false;
    let hookReviewReported = false;
    // What this PTY's output has been saying, throttled and classified
    // (issues 243 and 391).
    const outputActivity = new PtyOutputActivityWatcher();
    const watchOutput = plan.mode === "agent" && !opts.shell && !opts.shellSession;
    proc.onData((data: string) => {
      releaseSpawnHold();
      if (watchOutput) {
        if (p.taskId) {
          const kind = outputActivity.push(data, Date.now());
          if (kind) {
            try {
              this.deps.onSessionOutputActivity?.({ taskId: p.taskId, kind });
            } catch (err) {
              log.warn("pty.output-activity.failed", { error: String(err) });
            }
          }
        }
        const interrupted = hasClaudeInterruptPrompt(data);
        if (interrupted && !interruptReported) {
          interruptReported = true;
          reportOutputSignal(this.deps, p.taskId, "interrupted");
        } else if (!interrupted) {
          interruptReported = false;
        }
        const hooksNeedReview = hasCodexHookReviewPrompt(data);
        if (hooksNeedReview && !hookReviewReported) {
          hookReviewReported = true;
          reportOutputSignal(this.deps, p.taskId, "hooks-need-review");
        } else if (!hooksNeedReview) {
          hookReviewReported = false;
        }
      }
      const seq = appendBuffer(p, data);
      outputBatcher.push(id, seq, data, Date.now() - p.lastInputAt < PTY_INTERACTIVE_WINDOW_MS);
      promptDelivery?.onOutput(data);
    });
    proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      clearTimeout(settleTimer);
      releaseSpawnHold();
      // A PTY that died mid-delivery took the prompt with it, and `dispose()`
      // gives up silently — it sets `abandoned` without emitting, because it is
      // also the ordinary teardown of a delivery that finished. So the fact is
      // read off the phase here instead, and only the *reason* row is appended:
      // the status this Session settles on is the exit's to write, and a
      // `needs-input` raised against a harness that is already gone would fight
      // the line below for the row. (Issue 483, review of PR #487. The window
      // this covers is wider than it was — an opencode delivery may now be
      // waiting for its composer for up to 90 s rather than 15 — which is why
      // leaving it silent is no longer good enough.)
      if (
        promptDelivery &&
        p.taskId &&
        promptDelivery.currentPhase !== "delivered" &&
        promptDelivery.currentPhase !== "abandoned"
      ) {
        reportPromptAbandoned(this.deps, {
          taskId: p.taskId,
          ptyId: id,
          reason: "the harness exited before the prompt was delivered",
        });
      }
      promptDelivery?.dispose();
      outputBatcher.flush(id);
      sendToEmitTarget({ type: "exit", ptyId: id, exitCode, signal });
      // The Session's process is gone; its row has to settle whether or not a
      // Panel is watching (issue 84). Shells carry a taskId for routing but
      // are not agent work, so they settle nothing.
      if (!p.shell && !p.shellSession && p.agent && p.taskId) {
        try {
          this.deps.onSessionExit?.({ taskId: p.taskId, exitCode });
        } catch (err) {
          log.warn("pty.exit.settle-failed", { error: String(err) });
        }
      }
      ptys.delete(id);
    });

    return { ptyId: id, hooksReportTurnStart };
  }

  write(ptyId: string, data: string): boolean {
    const p = ptys.get(ptyId);
    if (!p) return false;
    p.lastInputAt = Date.now();
    p.proc.write(data);
    return true;
  }

  resize(ptyId: string, cols: number, rows: number): boolean {
    const p = ptys.get(ptyId);
    if (!p) return false;
    try {
      p.proc.resize(cols, rows);
    } catch {
      /* swallow */
    }
    return true;
  }

  kill(ptyId: string): boolean {
    const p = ptys.get(ptyId);
    if (!p) return false;
    disposePty(p.proc);
    ptys.delete(ptyId);
    return true;
  }

  async killLaunchProcesses(opts: {
    cwd: string;
    commands: string[];
    ports?: number[];
  }): Promise<{ ptyCount: number; ports: PortKillResult[] }> {
    const wanted = new Set((opts.commands ?? []).map(normalizedCommand).filter(Boolean));
    const targets = [...ptys.values()].filter(
      (p) => p.cwd === opts.cwd && wanted.has(normalizedCommand(p.command)),
    );
    await Promise.all(targets.map((p) => killPty(p)));

    const ports = planLaunchPortKillTargets(opts.ports ?? [], this.deps.getProtectedPorts());
    const portResults = await Promise.all(
      ports.map((target) =>
        target.protected
          ? {
              port: target.port,
              pids: [],
              killed: [],
              errors: ["skipped protected Actana Control runtime port"],
            }
          : killPidsListeningOnPort(target.port),
      ),
    );
    return { ptyCount: targets.length, ports: portResults };
  }

  /**
   * The Task this PTY was spawned for, or null when this Core has no such PTY.
   *
   * The inverse of {@link findByTask}, and the lookup the core-link server's
   * Session-lock gate is built on (issue 144, ADR 0024 D4): `write` and `kill`
   * name a `ptyId`, the lock is keyed by the Session, and a Session is its Task.
   *
   * **A read, and only a read.** The lock lives on the client-facing frame, not
   * in here: `PtyCore.kill` has callers inside the Core — the PTY exit paths and
   * the task writer — that are nobody's client and hold nobody's lock, and a
   * gate in this class would have the Core start refusing itself.
   *
   * Unlike `findByTask` this answers for **every** PTY, including project shells
   * and VM Shell Sessions. `findByTask` skips those because handing a raw shell
   * back to an agent reattach would be wrong; here the question is the opposite
   * one — "whose Session would this mutation be touching?" — and a shell's
   * answer is its own taskId, which is the id its own claim would name.
   */
  taskIdForPty(ptyId: string): string | null {
    if (typeof ptyId !== "string" || !ptyId) return null;
    return ptys.get(ptyId)?.taskId ?? null;
  }

  findByTask(taskId: string): { ptyId: string | null } {
    if (typeof taskId !== "string" || !taskId) return { ptyId: null };
    let found: string | null = null;
    for (const p of ptys.values()) {
      // Only agent sessions match by task. Shell terminals (project-scoped and
      // VM Shell Sessions) carry a taskId for routing but are not agent work —
      // a `findByTask` must not hand back a raw shell PTY to an agent reattach.
      if (p.taskId === taskId && !p.shell && !p.shellSession) found = p.id;
    }
    return { ptyId: found };
  }

  /**
   * The output a (re)attaching Panel is missing. `sinceSeq` is the seq it wants
   * to resume from — omitted on a first attach, set to "one past what I've
   * painted" on a reattach after a dropped link. See {@link sliceReplayWindow}
   * for what `from` tells the caller.
   */
  replay(ptyId: string, sinceSeq?: number): PtyReplayWindow {
    const p = ptys.get(ptyId);
    if (!p) return { data: "", nextSeq: 0 };
    outputBatcher.flush(ptyId);
    return sliceReplayWindow(p.buffer, p.nextSeq, sinceSeq);
  }

  killAll(): void {
    for (const p of ptys.values()) {
      disposePty(p.proc);
    }
    ptys.clear();
  }
}

export function killAllPtys() {
  activeCore?.killAll();
}
