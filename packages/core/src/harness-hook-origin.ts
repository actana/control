// Is this hook from the harness this Core spawned for the Session — or from
// something started underneath it?
//
// The hook env (`AC_HOOK_URL`, `AC_HOOK_TOKEN`, `AC_HOOK_SESSION_ID`) rides
// the PTY's environment, and environment is inherited. So every process that
// starts inside a Session's PTY — a nested `claude -p`, a headless helper, a
// second harness the operator runs from the Session's shell — reads the same
// workspace hook file and POSTs to the same session id (issue 460). The
// receiver authenticated the *machine* (loopback bind, per-boot bearer) but
// never the *process*: a nested harness's `SessionStart` was a capture event,
// so it took over the row's `claudeSessionId`, its lifecycle drove the card,
// and its `Stop` could settle a turn the real harness was still working.
//
// The discriminator is the one fact a nested process cannot inherit: its
// process id. The Core records the pid of the process it spawned for the
// Session (`PtyCore.spawnedProcessForSession`), and every hook this Core writes
// reports the pid of the process that ran it — `$PPID` from the shell
// families' `sh -c`, `process.pid` from the in-process plugin families. A hook
// is **owned** when that pid is the spawned one, or climbs to it through
// nothing but shells; anything else is **foreign**.
//
// Why the climb, and why only shells. The harness runs a hook as
// `/bin/sh -c "<command>"`, and the command is itself `sh -c '…'`. Where
// `/bin/sh` is bash (macOS) the outer shell execs the inner one and `$PPID` is
// the harness. Where it is dash (Debian, Ubuntu, the Core container) it forks,
// and `$PPID` is the outer `sh` — one shell above which sits the harness.
// Measured on Claude Code 2.1.295: the hook's parent chain is
// `sh → claude`, and a `claude -p` started from inside that Session's turn
// reports `sh → claude(nested) → bash → claude`. The nested harness is a
// process that is not a shell, and that is exactly what the climb refuses to
// cross. Nothing identifies a harness binary by name, because nothing has to:
// the question is only whether the chain from the hook to the spawned process
// is made of shells.
//
// The one launcher that is not the harness. What the PTY spawns is whatever
// the family's command resolves to on PATH, and for four families that is the
// harness itself: Claude Code is a native binary (the npm package's postinstall
// copies one into place), Cursor's `cursor-agent` is a shell launcher that
// `exec`s node and so keeps the pid, OpenCode is a native binary, and Pi is a
// single node process. Codex as this Core installs it (`npm install -g
// @openai/codex`) is different: its `bin/codex.js` is a node wrapper that
// `spawn`s the vendor binary as a child and stays alive as its parent,
// forwarding signals and mirroring the exit code (verified on 0.162.0: node
// wrapper pid 101931 → native `codex` pid 101939). The pid node-pty records is
// the wrapper; the harness that runs the hooks is its direct child, and a Codex
// hook's chain is `sh → codex(native) → node(spawned)`. So the Core records,
// per spawn, whether it launched the harness or a wrapper around it
// ({@link harnessLauncherShape}), and for a wrapper the climb may cross exactly
// one non-shell: the wrapper's own direct child. A nested harness under a
// Codex Session (`sh → claude(nested) → bash → codex(native) → node`) is still
// a non-shell whose parent is not the wrapper, and is still refused.
//
// What this does not do. It does not verify that the posting process is a
// descendant at all when the platform cannot read its process table — there
// the answer is `unverifiable`, the hook is taken as before, and the log says
// so. Linux reads `/proc`; macOS asks `ps`; anything else is unverifiable.
// And it does not close the exposure ADR 0020 accepts: a process with the
// token can still forge a request naming any pid. What it closes is the
// accidental case the issue is about — a harness started inside a Session,
// running the Session's own hook file in good faith.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { asCore } from "./core-identity";

/** What the receiver learned about the request, beyond its body. */
export type HookOrigin = {
  /** The harness family the URL named (`/api/hooks/<slug>`). */
  slug: string;
  /** The pid the hook reported (`?pid=`), or null when it reported none. */
  pid: number | null;
};

/** One process as the platform's process table reports it: its own name and its parent. */
export type ProcessEntry = {
  /** The executable's short name (`sh`, `bash`, `claude`, `node`, …). */
  comm: string;
  ppid: number;
};

/**
 * Read one process's name and parent.
 *
 * `null` means the process does not exist; `undefined` means this platform
 * cannot answer, which the caller treats as "unverifiable", never as
 * "foreign".
 */
export type ProcessEntryReader = (pid: number) => ProcessEntry | null | undefined;

export type HookProcessVerdict = "owned" | "foreign" | "unverifiable";

/**
 * What the PTY's spawned process is to the harness that runs the hooks.
 *
 * - `harness`: the spawned process is the harness itself (Claude Code,
 *   Cursor, OpenCode, Pi; Codex installed as a native binary).
 * - `wrapper`: the spawned process is a launcher that runs the harness as its
 *   direct child and stays alive as its parent — the npm `codex` wrapper
 *   (`bin/codex.js`).
 */
export type HarnessLauncherShape = "harness" | "wrapper";

/** The process this Core spawned for a Session, as the receiver holds hooks to it. */
export type SpawnedProcess = {
  pid: number;
  launcher: HarnessLauncherShape;
};

/**
 * The families whose vendor ships a launcher that keeps a parent alive above
 * the harness. Every other family's launcher is the harness (or `exec`s it,
 * which keeps the pid), so a non-shell under the spawned pid there is a
 * nested program and nothing else.
 */
const WRAPPED_LAUNCHER_FAMILIES: ReadonlySet<string> = new Set(["codex"]);

/**
 * Decide, at spawn, whether the resolved command is the harness or a wrapper
 * around it: `wrapper` only for a family that ships one (Codex) when what PATH
 * resolved to is an interpreter script rather than the native binary. A Codex
 * from Homebrew or Codex.app is the binary itself and stays `harness`.
 *
 * Deliberately not read off the process table later: the wrapper is a node
 * process whose main thread reports `comm` as `MainThread` on node 24, and the
 * climb matches no program by name. What the Core launched is a fact it has at
 * spawn time, so that is where it is recorded.
 */
export function harnessLauncherShape(agent: string, resolvedCommandIsScript: boolean): HarnessLauncherShape {
  return WRAPPED_LAUNCHER_FAMILIES.has(agent) && resolvedCommandIsScript ? "wrapper" : "harness";
}

/**
 * How many processes the climb will cross before giving up. A hook's shell
 * sits one or two below the harness; a bound this generous costs nothing and
 * stops a cycle in a lying process table from spinning.
 */
export const MAX_HOOK_PROCESS_HOPS = 8;

/**
 * Executables a hook's command may legitimately be running under, between its
 * own shell and the harness: the POSIX shells a vendor's hook runner spawns a
 * command with. A process by any other name on that path is a program of its
 * own — and the only program that runs this Core's hook file is a harness.
 */
const SHELL_NAMES: ReadonlySet<string> = new Set([
  "sh",
  "dash",
  "bash",
  "zsh",
  "ash",
  "ksh",
  "mksh",
  "fish",
  "busybox",
]);

function isShell(comm: string): boolean {
  return SHELL_NAMES.has(path.basename(comm));
}

/**
 * Decide whether a hook came from the process the Core spawned for the
 * Session.
 *
 * - no reported pid → `foreign`: every hook this Core writes reports one, so a
 *   request without it is not from a file this Core wrote;
 * - no spawned process → `foreign`: this Core runs no harness for the Session,
 *   so nothing it would own can be posting;
 * - reported pid is the spawned pid → `owned`;
 * - otherwise climb the reported pid's parents: reaching the spawned pid
 *   through shells only is `owned`; a non-shell on the way, a process that is
 *   gone, or a chain longer than {@link MAX_HOOK_PROCESS_HOPS} is `foreign`;
 * - for a `wrapper` spawn, one non-shell may be crossed, and only the one
 *   whose parent is the spawned pid: that is the harness the wrapper runs.
 *   A non-shell anywhere else in the chain is still `foreign`;
 * - a process table this platform cannot read → `unverifiable`.
 */
export function verifyHookProcess(
  reportedPid: number | null,
  spawned: SpawnedProcess | null,
  readProcess: ProcessEntryReader,
): HookProcessVerdict {
  if (reportedPid === null || !Number.isInteger(reportedPid) || reportedPid <= 0) return "foreign";
  if (spawned === null || !Number.isInteger(spawned.pid) || spawned.pid <= 0) return "foreign";
  const spawnedPid = spawned.pid;
  if (reportedPid === spawnedPid) return "owned";

  let pid = reportedPid;
  for (let hop = 0; hop < MAX_HOOK_PROCESS_HOPS; hop += 1) {
    const entry = readProcess(pid);
    if (entry === undefined) return "unverifiable";
    if (entry === null) return "foreign";
    if (!isShell(entry.comm)) {
      // The process we are standing on sits between the hook's own shell and
      // the spawned one, so it must be a shell for the climb to continue —
      // with one exception: a wrapper's direct child is the harness it runs,
      // and a Codex hook's chain is `sh → codex(native) → node(wrapper)`.
      // Only that child, and only under a wrapper: a non-shell whose parent is
      // anything else is a program of its own, which is the nested harness.
      // The reported pid is held to this too: its own name is the first fact
      // the climb learns.
      return spawned.launcher === "wrapper" && entry.ppid === spawnedPid ? "owned" : "foreign";
    }
    if (entry.ppid === spawnedPid) return "owned";
    if (entry.ppid <= 1) return "foreign";
    pid = entry.ppid;
  }
  return "foreign";
}

/**
 * Parse one line of `/proc/<pid>/stat`. The executable name sits in
 * parentheses and may itself contain spaces or parentheses, so the fields
 * after it are read from the LAST closing paren, never by splitting on
 * whitespace.
 */
export function parseProcStat(stat: string): ProcessEntry | null {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const comm = stat.slice(open + 1, close);
  // After the name: state, ppid, pgrp, …
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  if (!Number.isInteger(ppid)) return null;
  return { comm, ppid };
}

function readProcessFromProc(pid: number): ProcessEntry | null {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  return parseProcStat(stat);
}

function readProcessFromPs(pid: number): ProcessEntry | null {
  let out: string;
  try {
    // Synchronous, inside the receiver's request handler: at most
    // MAX_HOOK_PROCESS_HOPS reads of 2 s each for one hook, and in practice one
    // or two of a few milliseconds — a hook's shell sits one or two below the
    // harness. Through the identity wrapper like every child the Core starts;
    // outside the container (where macOS is) it is the spec unchanged.
    const launch = asCore({ command: "/bin/ps", args: ["-o", "ppid=,comm=", "-p", String(pid)] });
    out = execFileSync(launch.command, launch.args, {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      ...(launch.env ? { env: launch.env } : {}),
    });
  } catch {
    return null;
  }
  const line = out.trim();
  if (!line) return null;
  const space = line.search(/\s/);
  if (space < 0) return null;
  const ppid = Number(line.slice(0, space));
  if (!Number.isInteger(ppid)) return null;
  // macOS prints the executable's full path under `comm`; the basename is
  // what the shell list is keyed by.
  return { comm: path.basename(line.slice(space).trim()), ppid };
}

/**
 * The platform's process table: `/proc` where there is one, `ps` on macOS,
 * and nothing anywhere else — which the verdict reports as unverifiable
 * rather than guessing.
 */
export function readProcessEntry(pid: number): ProcessEntry | null | undefined {
  if (process.platform === "linux") return readProcessFromProc(pid);
  if (process.platform === "darwin") return readProcessFromPs(pid);
  return undefined;
}

/**
 * The query parameter a hook reports its process on. Named here so the hook
 * writers and the receiver cannot drift apart on the spelling.
 */
export const HOOK_PID_PARAM = "pid";

/** Parse `?pid=` as the receiver sees it: a positive integer, or nothing. */
export function parseReportedPid(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^\d{1,10}$/.test(raw)) return null;
  const pid = Number(raw);
  return pid > 0 ? pid : null;
}
