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
// process id. Every hook this Core writes reports the pid of the process that
// ran it — `$PPID` from the shell families' `sh -c`, `process.pid` from the
// in-process plugin families — and the Core knows the pid it spawned for the
// Session (`PtyCore.spawnedPidForSession`).
//
// What the spawned pid is, and is not. It is the ROOT of the Session's
// process tree: the process node-pty started. For most families that is the
// harness itself — Claude Code is one native binary, OpenCode is one native
// binary, Pi is one node process, Cursor's bash launcher `exec`s node, and
// the Core's own container wrapper is `sh -c 'cd … && exec "$@"'`, which
// keeps the pid too. It is NOT the harness for Codex as the Core installs it:
// `npm install -g @openai/codex` puts `bin/codex.js` on PATH, a node wrapper
// that `spawn`s the native binary and stays alive as its parent, so the root
// is the wrapper and the harness that runs the hooks is its child (measured
// on `@openai/codex@0.162.0`: `node bin/codex.js` ← `codex`). Holding a hook
// to the root pid itself would refuse every Codex hook; that was round 2 of
// this fix. So the harness is FOUND under the root, by the shape of the
// process tree, and nothing here names a harness or a wrapper — a launcher
// the Core has never heard of must keep working.
//
// Three steps, each a climb through the process table:
//
// 1. **The program that ran the hook.** A harness runs a hook as
//    `/bin/sh -c "<command>"`, and the command is itself `sh -c '…'`. Where
//    `/bin/sh` is bash (macOS) the outer shell execs the inner one and `$PPID`
//    is the harness; where it is dash (Debian, the Core container) it forks and
//    `$PPID` is the outer shell, one below the harness. So the climb from the
//    reported pid crosses the hook's own shells, and the first process that is
//    not a shell is the program that ran the hook: the Session's harness, or a
//    harness nested inside it. (A plugin family reports the program outright.)
// 2. **Its place under the root.** From that program the climb continues to
//    the root through programs only — launcher wrappers are programs. A SHELL
//    on this stretch means the program was started by a shell the harness ran:
//    a Bash tool call, the operator's own `claude` from the Session's shell.
//    That is a nested harness, and the hook is foreign. Measured on Claude
//    Code 2.1.295 on a Debian Core: an owned hook's chain is `sh → claude`, a
//    `claude -p` run from inside the Session's turn reports
//    `sh → claude(nested) → bash → claude`, and the Codex chain is
//    `sh → codex → node(bin/codex.js)`. Not reaching the root at all — the
//    process is gone, reparented, or a stranger with the env — is foreign.
// 3. **Seniority.** The one shape step 2 cannot see is a harness started by a
//    program rather than a shell — an MCP server that spawns `claude`, say —
//    because from the tree alone that is indistinguishable from a launcher
//    wrapper above the harness. So the receiver also remembers which program
//    has been running the Session's hooks (`boundHarnessPid`): the first owned
//    hook binds its program, a later hook from a DESCENDANT of the bound
//    program is foreign, and a hook from an ANCESTOR of it re-binds. The
//    ancestor case is the real harness arriving after its first POSTs were
//    lost on a busy Core (`curl -m 3 --retry 2` can drop them), and re-binding
//    upward is what keeps a Session from ever being wedged on a nested process.
//
// What this does not do. It does not verify anything when the platform
// cannot read its process table — there the answer is `unverifiable`, the
// hook is taken as before, and the log says so. Linux reads `/proc`; macOS
// takes one `ps` snapshot per hook; anything else is unverifiable. It does not
// support a launcher that is a forking shell (one that runs the harness
// without `exec`): to the tree that is a tool shell, and it is not a shape any
// family the Core installs has. And it does not close the exposure ADR 0020
// accepts: a process with the token can still forge a request naming any pid.
// What it closes is the accidental case the issue is about — a harness
// started inside a Session, running the Session's own hook file in good faith.

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
  /**
   * The executable's short name (`sh`, `bash`, `claude`, `node`, …). Node 24
   * reports its main thread as `MainThread`; the only names that matter here
   * are the shells', so that is fine.
   */
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

/** Why a hook was refused — for the log line, so an operator can tell the shapes apart. */
export type HookForeignReason =
  /** The request named no pid, or not a usable one: not from a file this Core wrote. */
  | "no-pid"
  /** The Core runs no harness for this Session: nothing it would own can be posting. */
  | "no-root"
  /** The reported process does not climb to the spawned root at all, or is gone. */
  | "not-under-root"
  /** The program that ran the hook was started by a shell the harness ran: nested. */
  | "started-by-a-shell"
  /** The program is a descendant of the one already running the Session's hooks. */
  | "nested-under-harness"
  /** The program is neither above nor below the bound harness: a second tree under the root. */
  | "beside-harness";

export type HookProcessVerdict =
  /** The Session's own harness; `harnessPid` is the program that ran the hook, to bind. */
  | { verdict: "owned"; harnessPid: number }
  | { verdict: "foreign"; reason: HookForeignReason }
  /** The platform's process table cannot be read; the caller takes the hook as owned and logs. */
  | { verdict: "unverifiable" };

/**
 * How many processes one climb will cross before giving up. A hook's shells
 * sit one or two below the harness and a launcher wrapper one above it; a
 * bound this generous costs nothing and stops a cycle in a lying process
 * table from spinning.
 */
export const MAX_HOOK_PROCESS_HOPS = 8;

/**
 * Executables a hook's command may legitimately be running under, between its
 * own shell and the harness: the POSIX shells a vendor's hook runner spawns a
 * command with. A process by any other name is a program of its own. These
 * are the ONLY names the guard knows; no harness and no launcher is ever
 * matched by name.
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

function validPid(pid: number | null): pid is number {
  return pid !== null && Number.isInteger(pid) && pid > 0;
}

/**
 * Decide whether a hook came from the harness this Core spawned for the
 * Session.
 *
 * - `reportedPid` — what the hook said ran it (`?pid=`);
 * - `rootPid` — what the Core spawned for the Session, the root of its
 *   process tree (`PtyCore.spawnedPidForSession`), or null when it runs none;
 * - `boundHarnessPid` — the program that has been running this Session's
 *   hooks so far, as the caller remembers it from the last owned verdict, or
 *   null before the first.
 *
 * See the file comment for the three steps. The answer is pure in the process
 * table it is handed, which is how the tests drive it.
 */
export function verifyHookProcess(
  reportedPid: number | null,
  rootPid: number | null,
  boundHarnessPid: number | null,
  readProcess: ProcessEntryReader,
): HookProcessVerdict {
  if (!validPid(reportedPid)) return { verdict: "foreign", reason: "no-pid" };
  if (!validPid(rootPid)) return { verdict: "foreign", reason: "no-root" };

  // 1. The program that ran the hook: cross the hook's own shells.
  let pid = reportedPid;
  let program: number | null = null;
  let programParent = 0;
  for (let hop = 0; hop <= MAX_HOOK_PROCESS_HOPS; hop += 1) {
    if (pid === rootPid) {
      // The hook's shells hang straight off the root: the root ran it.
      program = rootPid;
      break;
    }
    const entry = readProcess(pid);
    if (entry === undefined) return { verdict: "unverifiable" };
    if (entry === null) return { verdict: "foreign", reason: "not-under-root" };
    if (!isShell(entry.comm)) {
      program = pid;
      programParent = entry.ppid;
      break;
    }
    if (entry.ppid <= 1) return { verdict: "foreign", reason: "not-under-root" };
    pid = entry.ppid;
  }
  if (program === null) return { verdict: "foreign", reason: "not-under-root" };

  // 2. Its place under the root: through programs only. `lineage` is every
  //    process from the program (exclusive) to the root (inclusive).
  const lineage: number[] = [];
  if (program !== rootPid) {
    pid = programParent;
    for (let hop = 0; ; hop += 1) {
      if (pid === rootPid) {
        lineage.push(rootPid);
        break;
      }
      if (hop >= MAX_HOOK_PROCESS_HOPS || pid <= 1) return { verdict: "foreign", reason: "not-under-root" };
      const entry = readProcess(pid);
      if (entry === undefined) return { verdict: "unverifiable" };
      if (entry === null) return { verdict: "foreign", reason: "not-under-root" };
      if (isShell(entry.comm)) return { verdict: "foreign", reason: "started-by-a-shell" };
      lineage.push(pid);
      pid = entry.ppid;
    }
  }

  // 3. Seniority against the program already running the Session's hooks.
  if (boundHarnessPid === null || boundHarnessPid === program) {
    return { verdict: "owned", harnessPid: program };
  }
  if (lineage.includes(boundHarnessPid)) {
    return { verdict: "foreign", reason: "nested-under-harness" };
  }
  // Is the program an ancestor of the bound one? Then the bound one was the
  // nested process (or the real harness's first POSTs were lost), and the
  // program takes over. A bound process that is gone has nothing to hold the
  // row any more, and the program takes over too.
  pid = boundHarnessPid;
  for (let hop = 0; hop < MAX_HOOK_PROCESS_HOPS; hop += 1) {
    const entry = readProcess(pid);
    if (entry === undefined) return { verdict: "unverifiable" };
    if (entry === null) return { verdict: "owned", harnessPid: program };
    if (entry.ppid === program) return { verdict: "owned", harnessPid: program };
    if (entry.ppid === rootPid || entry.ppid <= 1) break;
    pid = entry.ppid;
  }
  return { verdict: "foreign", reason: "beside-harness" };
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

/**
 * Parse the output of `ps -axo pid=,ppid=,comm=`: one process per line, pid,
 * parent, then the executable — which macOS prints as a full path, so the
 * basename is what the shell list is keyed by.
 */
export function parsePsTable(out: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    table.set(Number(m[1]), { comm: path.basename(m[3]!.trim()), ppid: Number(m[2]) });
  }
  return table;
}

/**
 * One `ps` snapshot of the whole table, taken the first time it is asked and
 * reused for every hop of every climb for this hook. One synchronous child
 * (2 s timeout) per hook in the receiver's request handler is the cost of
 * macOS having no `/proc`; per hop it would be up to three climbs of eight.
 * The reader is lazy so a hook whose reported pid IS the root never pays it.
 */
function snapshotFromPs(): ProcessEntryReader {
  let table: Map<number, ProcessEntry> | null | undefined;
  return (pid) => {
    if (table === undefined) {
      try {
        // Through the identity wrapper like every child the Core starts;
        // outside the container (where macOS is) it is the spec unchanged.
        const launch = asCore({ command: "/bin/ps", args: ["-axo", "pid=,ppid=,comm="] });
        const out = execFileSync(launch.command, launch.args, {
          encoding: "utf8",
          timeout: 2000,
          stdio: ["ignore", "pipe", "ignore"],
          ...(launch.env ? { env: launch.env } : {}),
        });
        table = parsePsTable(out);
      } catch {
        table = null;
      }
    }
    if (table === null) return undefined;
    return table.get(pid) ?? null;
  };
}

/**
 * The platform's process table, opened for one hook: `/proc` where there is
 * one, a `ps` snapshot on macOS, and nothing anywhere else — which the
 * verdict reports as unverifiable rather than guessing.
 */
export function openProcessTable(): ProcessEntryReader {
  if (process.platform === "linux") return readProcessFromProc;
  if (process.platform === "darwin") return snapshotFromPs();
  return () => undefined;
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
