import type { CoreClient } from "@actana/sdk/core";
import { SESSION_PROMPT_EVENT_KIND, type SessionPromptPayload } from "@actana/shared/harness-hook-prompt";
import { DomainError } from "../errors";
import { getAgent } from "../services/agents";
import { coreLinkManager } from "../services/core-link-manager";
import { addTaskComment, findCurrentTaskSession, getTask, type Task } from "../services/tasks";
import { buildTaskPrompt, maskSecrets, planAnswer, type HookPromptHint, type TaskAnswer, type TaskPrompt } from "./task-input";

/**
 * A Task whose Session waits at a prompt, read and answered through the Panel's own link to the Core (#959): the prompt is
 * read live from the Core's PTY (`replay`), classified (`task-input.ts`), and an answer is written to the PTY. Nothing is
 * stored: a prompt only exists while its PTY does.
 */

/** A refusal the caller can act on: `code` is stable (`not_waiting`, `stale_prompt`, `needs_human`, `invalid_answer`, `prompt_unavailable`, `write_failed`). */
export class TaskAnswerError extends DomainError {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type TaskInputDeps = {
  link(coreId: string): { readonly sdk?: Pick<CoreClient, "findBySession" | "replay" | "write"> } | null;
  /** What the hook that set `needs-input` said, from the Core's `session:prompt` event. */
  hint(coreId: string, sessionId: string): HookPromptHint | null;
  /** The Task row, read again after the screen: the prompt's id must not be older than the screen. */
  task(ownerId: number, taskId: string): Promise<Task>;
  harness(ownerId: number, agentId: string): Promise<string | null>;
  session(ownerId: number, taskId: string): Promise<{ coreId: string; sessionId: string } | null>;
};

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;

/** The Panel's per-Core memory of the last hook's `session:prompt`, filled from each link's events. */
export class SessionPromptFeed {
  private readonly hints = new Map<string, HookPromptHint>();
  private readonly unsubscribes = new Map<string, () => void>();

  /** Listen on every link the manager has now or later. Returns a function that stops listening. */
  attach(manager: Pick<ReturnType<typeof coreLinkManager>, "onClient"> = coreLinkManager()): () => void {
    const off = manager.onClient((coreId, client) => {
      this.unsubscribes.get(coreId)?.();
      this.unsubscribes.set(coreId, client.onEvent(({ event }) => this.push(coreId, event.kind, event.payload)));
    });
    return () => {
      off();
      for (const unsubscribe of this.unsubscribes.values()) unsubscribe();
      this.unsubscribes.clear();
    };
  }

  /** One Core event. The hint lives from `session:prompt` until the Session's status moves off `needs-input`. */
  push(coreId: string, kind: string, payload: string): void {
    if (kind !== SESSION_PROMPT_EVENT_KIND && kind !== "session:updated" && kind !== "session:deleted") return;
    let parsed: Partial<SessionPromptPayload> & { status?: unknown };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed.sessionId !== "string") return;
    const key = `${coreId}\u0000${parsed.sessionId}`;
    if (kind === SESSION_PROMPT_EVENT_KIND) {
      if (parsed.kind !== "question" && parsed.kind !== "choice" && parsed.kind !== "permission") return;
      this.hints.delete(key);
      this.hints.set(key, {
        kind: parsed.kind,
        ...(typeof parsed.tool === "string" ? { tool: parsed.tool } : {}),
        ...(typeof parsed.text === "string" ? { text: parsed.text } : {}),
        ...(Array.isArray(parsed.options) ? { options: parsed.options.filter((o) => typeof o?.label === "string").map((o) => ({ label: o.label })) } : {}),
      });
      if (this.hints.size > MAX_HINTS) this.hints.delete(this.hints.keys().next().value as string);
      return;
    }
    if (kind === "session:deleted" || (typeof parsed.status === "string" && parsed.status !== "needs-input")) this.hints.delete(key);
  }

  hint(coreId: string, sessionId: string): HookPromptHint | null {
    return this.hints.get(`${coreId}\u0000${sessionId}`) ?? null;
  }
}

const MAX_HINTS = 500;

const promptFeed = new SessionPromptFeed();
export const sessionPromptFeed = (): SessionPromptFeed => promptFeed;

const defaultDeps: TaskInputDeps = {
  link: (coreId) => coreLinkManager().client(coreId),
  hint: (coreId, sessionId) => promptFeed.hint(coreId, sessionId),
  task: (ownerId, taskId) => getTask(ownerId, taskId),
  harness: async (ownerId, agentId) => (await getAgent(ownerId, agentId).catch(() => null))?.harness ?? null,
  session: (ownerId, taskId) => findCurrentTaskSession(ownerId, taskId),
};

let deps: TaskInputDeps = defaultDeps;

/** @internal — stand-in Core links for suites that have no Core to dial; `null` restores the real ones. */
export function setTaskInputDepsForTests(replacement: Partial<TaskInputDeps> | null): void {
  deps = replacement ? { ...defaultDeps, ...replacement } : defaultDeps;
  answered.clear();
  inFlight.clear();
}

const READ_TIMEOUT_MS = 10_000;
/** The prompt last answered per Task: a second answer to the same prompt is stale, whatever `expect` says. */
const answered = new Map<string, number>();
/** One answer at a time per Task. */
const inFlight = new Set<string>();

async function readScreen(task: Task): Promise<{ screen: string; ptyId: string; sdk: NonNullable<ReturnType<TaskInputDeps["link"]>>["sdk"] } & { coreId: string; sessionId: string } | null> {
  const where = await deps.session(task.ownerId, task.id);
  if (!where) return null;
  const sdk = deps.link(where.coreId)?.sdk;
  if (!sdk) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (async () => {
      const { ptyId } = await sdk.findBySession(where.sessionId);
      if (!ptyId) return null;
      const replay = await sdk.replay(ptyId);
      return { screen: replay.data, ptyId, sdk, ...where };
    })();
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
    });
    return await Promise.race([read, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the Task's Session asks: `null` unless its state is `needs-input` (and the Core can be read). `at` is when the
 * Session went to `needs-input`, the id of the prompt.
 */
export async function readTaskPrompt(task: Task): Promise<TaskPrompt | null> {
  const waiting = await readWaiting(task);
  return waiting === null || waiting === "moved" ? null : waiting.prompt;
}

async function readWaiting(task: Task): Promise<{ prompt: TaskPrompt; ptyId: string; sdk: NonNullable<ReturnType<TaskInputDeps["link"]>>["sdk"] } | "moved" | null> {
  if (task.sessionState !== "needs-input" || task.sessionStateAt === null || !task.agent) return null;
  const [harness, read] = await Promise.all([deps.harness(task.ownerId, task.agent), readScreen(task)]);
  if (!harness || !read) return null;
  const prompt = buildTaskPrompt({ harness, screen: read.screen, hook: deps.hint(read.coreId, read.sessionId), at: task.sessionStateAt });
  // The read can take seconds: if the Session moved on meanwhile, `at` is older than the screen.
  const fresh = await deps.task(task.ownerId, task.id).catch(() => null);
  if (!fresh || fresh.sessionState !== "needs-input" || fresh.sessionStateAt !== prompt.at) return "moved";
  return { prompt, ptyId: read.ptyId, sdk: read.sdk };
}

/** The first non-empty line of a prompt, for the record. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const one = line.trim().replace(/"/g, "'");
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
}

/**
 * Answer a Task's prompt. Refused (nothing typed) unless the Task's Session is `needs-input` (`not_waiting`), `expect` is the
 * `at` of the prompt now on the screen and it was not answered already (`stale_prompt`), the prompt is not one the
 * orchestrator never answers (`needs_human`) and the answer is well formed (`invalid_answer`). Typed with an unstamped
 * `write`: the Core's refusal of sends into a blocked Session (#924) is for sends, and this is the deliberate path past it.
 * Then one comment: `Answered by <by>: <kind> "<prompt first line>" → <answer>`.
 */
export async function answerTask(task: Task, input: { answer: TaskAnswer; expect?: number; by: string }): Promise<{ prompt: TaskPrompt; summary: string }> {
  if (task.sessionState !== "needs-input") {
    throw new TaskAnswerError(HTTP_CONFLICT, "not_waiting", "this Task's Session is not waiting for input: nothing was typed");
  }
  if (inFlight.has(task.id)) throw new TaskAnswerError(HTTP_CONFLICT, "stale_prompt", "another answer to this Task is being typed: read the prompt again");
  inFlight.add(task.id);
  try {
    const waiting = await readWaiting(task);
    if (waiting === "moved") {
      throw new TaskAnswerError(HTTP_CONFLICT, "stale_prompt", "the Session asked something else while its prompt was read: read it again with get_task. Nothing was typed");
    }
    if (!waiting?.sdk) {
      throw new TaskAnswerError(HTTP_CONFLICT, "prompt_unavailable", "the prompt could not be read from the Core (offline, or the Session's PTY is gone): nothing was typed");
    }
    const { prompt } = waiting;
    if ((input.expect !== undefined && input.expect !== prompt.at) || answered.get(task.id) === prompt.at) {
      throw new TaskAnswerError(HTTP_CONFLICT, "stale_prompt", "the Session asks a different prompt now (or this one was answered): read it again with get_task. Nothing was typed");
    }
    const plan = planAnswer(prompt, input.answer);
    if (!plan.ok) throw new TaskAnswerError(plan.code === "needs_human" ? HTTP_CONFLICT : HTTP_BAD_REQUEST, plan.code, `${plan.message}. Nothing was typed`);
    if (!(await waiting.sdk.write(waiting.ptyId, plan.bytes))) {
      throw new TaskAnswerError(HTTP_BAD_GATEWAY, "write_failed", "the Core did not take the answer: nothing was typed");
    }
    answered.set(task.id, prompt.at);
    if (answered.size > MAX_HINTS) answered.delete(answered.keys().next().value as string);
    const summary = maskSecrets(plan.summary);
    await addTaskComment(task.ownerId, task.id, {
      authorKind: "user",
      authorName: input.by,
      body: `Answered by ${input.by}: ${prompt.kind} "${firstLine(prompt.text)}" → ${summary}`,
    });
    return { prompt, summary };
  } finally {
    inFlight.delete(task.id);
  }
}

