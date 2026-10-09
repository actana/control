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
// Session (`PtyCore.spawnedPidForSession`), and every hook this Core writes
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
 * - no spawned pid → `foreign`: this Core runs no harness for the Session, so
 *   nothing it would own can be posting;
 * - reported pid is the spawned pid → `owned`;
 * - otherwise climb the reported pid's parents: reaching the spawned pid
 *   through shells only is `owned`; a non-shell on the way, a process that is
 *   gone, or a chain longer than {@link MAX_HOOK_PROCESS_HOPS} is `foreign`;
 * - a process table this platform cannot read → `unverifiable`.
 */
export function verifyHookProcess(
  reportedPid: number | null,
  spawnedPid: number | null,
  readProcess: ProcessEntryReader,
): HookProcessVerdict {
  if (reportedPid === null || !Number.isInteger(reportedPid) || reportedPid <= 0) return "foreign";
  if (spawnedPid === null || !Number.isInteger(spawnedPid) || spawnedPid <= 0) return "foreign";
  if (reportedPid === spawnedPid) return "owned";

  let pid = reportedPid;
  for (let hop = 0; hop < MAX_HOOK_PROCESS_HOPS; hop += 1) {
    const entry = readProcess(pid);
    if (entry === undefined) return "unverifiable";
    if (entry === null) return "foreign";
    // The process we are standing on sits between the hook's own shell and
    // the harness, so it must itself be a shell for the climb to continue.
    // The reported pid is held to this too: its own name is the first fact
    // the climb learns.
    if (!isShell(entry.comm)) return "foreign";
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
    out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
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
