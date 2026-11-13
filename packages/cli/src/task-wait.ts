// `actana task wait <watch-url>` (#953): loop on a Task's status URL.
//
// A worker that hands a Task off to another Core used to wait by looping MCP
// calls or by sleeping, and either burns tokens and turns. The Panel mints a
// status URL for every attempt (#950, `GET /api/watch/<token>`, no cookie and
// no key) and tells the caller how soon to ask again in `pollAfterSeconds`;
// this is the loop that obeys it.
//
// **A local command, not a client noun.** It needs no pairing and no key — the
// token in the URL is the credential — so it lives beside the machine verbs and
// not in `@actana/cli`, whose nouns change only with a client release.
//
// **The URL is never printed.** Its token is a credential for the length of the
// attempt, and stderr ends up in logs and in agents' transcripts.
//
// Every side effect (fetch, sleep, clock, randomness) is a port so the whole
// loop runs under test with no real sleeps; `runTaskWait` binds the real ones
// when none are given.

import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_TASK_FAILED,
  EXIT_TASK_GONE,
  EXIT_TASK_IDLE_NO_RESULT,
  EXIT_TASK_INTERRUPTED,
  EXIT_TASK_NEEDS_INPUT,
  EXIT_TASK_PARTIAL,
  EXIT_TASK_TIMEOUT,
  EXIT_USAGE,
} from "./exit-codes.ts";

export type TaskWaitPorts = {
  fetch: (url: string) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** In [0, 1). */
  random: () => number;
};

export type TaskWaitIo = { out: (line: string) => void; err: (line: string) => void };

/** The watch payload (#950). Shared word for word with the Studio twin: read, never extended here. */
type WatchAnswer = {
  taskId?: string;
  status: string;
  sessionState: string | null;
  result: string | null;
  pollAfterSeconds: number;
};

const MIN_POLL_S = 2;
const MAX_POLL_S = 60;
const JITTER = 0.2;
const MAX_BACKOFF_S = 60;
/** How long with no good answer before the wait gives up. */
const GIVE_UP_MS = 10 * 60_000;
/** Used when a `429` carries no usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_S = 60;
/** A `Retry-After` longer than this is cut to it: the give-up window is the longest a caller should sit silent. */
const MAX_RETRY_AFTER_S = 10 * 60;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The same loop for callers without `actana`: stops on a result or on a Session state that needs a person,
 * and ends non-zero on any HTTP error (410, 404, 429 …), because the loop then leaves with no `ok`.
 */
export const TASK_WAIT_CURL =
  `u='<watch-url>'; ok=; while b=$(curl -fsS "$u"); do case $b in *'"result":"'*|*'"needs-input"'*|*'"interrupted"'*|*'"idle-no-result"'*) ok=1; break;; esac; sleep 5; done; echo "$b"; [ -n "$ok" ]`;

export const TASK_WAIT_HELP = `actana task wait <watch-url> — wait for a Task by looping on its status URL.

Usage:
  actana task wait <watch-url> [--until-final] [--timeout <minutes>] [--json]

The URL is the Task's status URL (\`watch.url\`). It needs no pairing and no key.
Asks again after the \`pollAfterSeconds\` the Panel answers with (2–60 s, ±20 %
jitter), honours \`Retry-After\` on 429, and backs off up to 60 s on network
errors, giving up after 10 minutes without one good answer. One line on stderr
per state change; with --json the last answer is printed on stdout.

Stops when:
  the Task is done, failed or partial          the Session needs input, was
  interrupted or went idle without a result    (unless --until-final)
  the URL is gone (410)                        --timeout runs out

Options:
  --until-final         Ignore the Session states and wait for a final status
  --timeout <minutes>   Stop waiting after this long
  --json                Print the last answer as one JSON line on stdout

Exit codes:
  0 done            10 failed          11 partial
  20 needs-input    21 interrupted     22 idle-no-result
  30 gone (410)     31 timeout         1 error      2 usage

Without \`actana\`, the same loop in a shell (stops on a result or on a Session
state that needs a person; non-zero on any HTTP error):
  ${TASK_WAIT_CURL}
`;

const STOP_STATES: Record<string, number> = {
  "needs-input": EXIT_TASK_NEEDS_INPUT,
  interrupted: EXIT_TASK_INTERRUPTED,
  "idle-no-result": EXIT_TASK_IDLE_NO_RESULT,
};

const FINAL_CODES: Record<string, number> = {
  done: EXIT_OK,
  failed: EXIT_TASK_FAILED,
  partial: EXIT_TASK_PARTIAL,
};

const realPorts: TaskWaitPorts = {
  fetch: (url) =>
    fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  random: () => Math.random(),
};

type Parsed = { url: string; untilFinal: boolean; timeoutMs: number | null; json: boolean } | { help: true } | { error: string };

function parseTaskWaitArgs(argv: string[]): Parsed {
  let url: string | undefined;
  let untilFinal = false;
  let json = false;
  let timeoutMs: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--until-final") untilFinal = true;
    else if (a === "--json") json = true;
    else if (a === "--timeout" || a.startsWith("--timeout=")) {
      const raw = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      const minutes = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { error: `--timeout must be a positive number of minutes, got ${JSON.stringify(raw ?? "")}` };
      }
      timeoutMs = minutes * 60_000;
    } else if (a.startsWith("-")) return { error: `unknown option: ${a}` };
    else if (url !== undefined) return { error: `unexpected argument: ${a}` };
    else url = a;
  }
  if (url === undefined) return { error: "actana task wait needs the Task's status URL" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "the status URL is not a URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { error: "the status URL must be http or https" };
  }
  return { url, untilFinal, timeoutMs, json };
}

function readAnswer(body: unknown): WatchAnswer | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.status !== "string") return null;
  const poll = typeof b.pollAfterSeconds === "number" && Number.isFinite(b.pollAfterSeconds) ? b.pollAfterSeconds : 5;
  return {
    taskId: typeof b.taskId === "string" ? b.taskId : undefined,
    status: b.status,
    sessionState: typeof b.sessionState === "string" ? b.sessionState : null,
    result: typeof b.result === "string" ? b.result : null,
    pollAfterSeconds: poll,
  };
}

/** Seconds from a `Retry-After` value: delta-seconds or an HTTP date. */
function retryAfterSeconds(header: string | null, now: number): number {
  if (header !== null) {
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) return Math.min(Math.max(Number(trimmed), 1), MAX_RETRY_AFTER_S);
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) return Math.min(Math.max(Math.ceil((date - now) / 1000), 1), MAX_RETRY_AFTER_S);
  }
  return DEFAULT_RETRY_AFTER_S;
}

/** `pollAfterSeconds` clamped to 2–60 s, ±20 % jitter, then clamped again: the sleep never leaves 2–60 s. */
function pollDelayMs(pollAfterSeconds: number, random: () => number): number {
  const base = Math.min(Math.max(pollAfterSeconds, MIN_POLL_S), MAX_POLL_S) * 1000;
  const ms = base * (1 + (random() * 2 - 1) * JITTER);
  return Math.round(Math.min(Math.max(ms, MIN_POLL_S * 1000), MAX_POLL_S * 1000));
}

/** 2, 4, 8 … 60 s after the nth failure in a row, jittered but never past 60 s. */
function backoffMs(failures: number, random: () => number): number {
  const base = Math.min(2 ** failures, MAX_BACKOFF_S) * 1000;
  return Math.min(Math.round(base * (1 + (random() * 2 - 1) * JITTER)), MAX_BACKOFF_S * 1000);
}

function describeState(a: WatchAnswer): string {
  const task = a.taskId ? `task ${a.taskId}: ` : "task: ";
  return `${task}${a.status}${a.sessionState ? ` · session ${a.sessionState}` : ""}`;
}

/** Run `actana task wait`. Returns the exit code; never calls process.exit. */
export async function runTaskWait(
  argv: string[],
  io: TaskWaitIo,
  ports: Partial<TaskWaitPorts> = {},
): Promise<number> {
  const p: TaskWaitPorts = { ...realPorts, ...ports };
  const args = parseTaskWaitArgs(argv);
  if ("help" in args) {
    io.out(TASK_WAIT_HELP.trimEnd());
    return EXIT_OK;
  }
  if ("error" in args) {
    io.err(args.error);
    io.err("Usage: actana task wait <watch-url> [--until-final] [--timeout <minutes>] [--json]");
    return EXIT_USAGE;
  }

  const startedAt = p.now();
  const deadline = args.timeoutMs === null ? null : startedAt + args.timeoutMs;
  let lastGoodAt = startedAt;
  let failures = 0;
  let last: WatchAnswer | null = null;
  let lastRaw: string | null = null;
  let lastShown: string | null = null;

  /** The last good answer goes to stdout under --json, whatever ended the wait. */
  const finish = (code: number): number => {
    if (args.json && lastRaw !== null) io.out(lastRaw);
    return code;
  };
  /** Sleep, but never past the --timeout. */
  const wait = (ms: number) => p.sleep(deadline === null ? ms : Math.max(0, Math.min(ms, deadline - p.now())));

  for (;;) {
    if (deadline !== null && p.now() >= deadline) {
      io.err(`still waiting when --timeout ran out${last ? ` (${describeState(last)})` : ""}`);
      return finish(EXIT_TASK_TIMEOUT);
    }
    if (p.now() - lastGoodAt >= GIVE_UP_MS) {
      io.err("giving up: no good answer from the status URL for 10 minutes");
      return finish(EXIT_FAILURE);
    }

    let res: Response | null = null;
    let problem = "";
    try {
      res = await p.fetch(args.url);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }

    if (res === null || res.status >= 500 || res.status === 408) {
      failures++;
      if (res !== null) problem = `HTTP ${res.status}`;
      io.err(`status URL unreachable (${problem}), retrying`);
      await wait(backoffMs(failures, p.random));
      continue;
    }

    if (res.status === 410) {
      io.err("the status URL is gone (410): the attempt ended, was replaced, stopped or deleted, or the link expired");
      return finish(EXIT_TASK_GONE);
    }

    if (res.status === 429) {
      const seconds = retryAfterSeconds(res.headers.get("retry-after"), p.now());
      io.err(`rate limited (429), waiting ${seconds} s`);
      await wait(seconds * 1000);
      continue;
    }

    if (!res.ok) {
      io.err(`the status URL answered HTTP ${res.status}: check the URL`);
      return finish(EXIT_FAILURE);
    }

    let answer: WatchAnswer | null = null;
    let raw = "";
    try {
      const body: unknown = await res.json();
      answer = readAnswer(body);
      raw = JSON.stringify(body);
    } catch {
      answer = null;
    }
    if (answer === null) {
      io.err("the status URL did not answer with a Task status: check the URL");
      return finish(EXIT_FAILURE);
    }

    failures = 0;
    lastGoodAt = p.now();
    last = answer;
    lastRaw = raw;

    const shown = describeState(answer);
    if (shown !== lastShown) {
      io.err(shown);
      lastShown = shown;
    }

    const finalCode = FINAL_CODES[answer.status];
    if (finalCode !== undefined) return finish(finalCode);
    const stopCode = answer.sessionState === null ? undefined : STOP_STATES[answer.sessionState];
    if (stopCode !== undefined && !args.untilFinal) return finish(stopCode);

    await wait(pollDelayMs(answer.pollAfterSeconds, p.random));
  }
}
