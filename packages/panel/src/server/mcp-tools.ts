import { z } from "zod";
import type { ApiPrincipal } from "./api-key-auth";
import { forbidden } from "./controllers/_helpers";
import {
  addTaskCommentV1,
  answerTaskBody,
  answerTaskV1,
  createAgentV1,
  createTaskV1,
  deleteAgentV1,
  closeTaskSessionV1,
  deleteTaskV1,
  getTaskV1,
  listAgentsV1,
  listCoreAgentsV1,
  listCoresV1,
  listSessionsV1,
  listTasksV1,
  setTaskStatusV1,
  stopTaskV1,
  updateAgentV1,
  updateTaskV1,
} from "./controllers/v1.controller";
import { GUIDE_TOPICS, guideMarkdown } from "./mcp-guides";
import { getShared, listShared } from "./mcp-shared";
import { OPERATOR_TASK_STATUSES } from "./controllers/tasks.controller";
import { scopeReaches } from "./services/api-keys";
import type { ApiKeyPermission } from "~/shared/api-key-permissions";
import { SESSION_PAGE_MAX, SESSION_STATUS_FILTERS } from "@actana/shared/session-paging";
import { AGENT_FLAGS, AGENT_NAME_MAX, HARNESSES } from "~/shared/agents";
import { TASKS_PAGE_MAX_LIMIT, TASKS_WITH_DESCRIPTIONS_MAX_LIMIT, TASK_SESSION_STATES, TASK_STATUSES } from "~/shared/tasks";

/**
 * The MCP tools (#573). Each one is a thin call into the same handlers the
 * public REST API runs (`controllers/v1.controller.ts`), with the principal the
 * key gate resolved, so the owner and Core-scope rules exist once: a tool never
 * decides who it runs as or which Cores it may see. Each tool names the one
 * permission it needs (#688), the same one its REST route needs; the server
 * lists a key only the tools it may call and refuses the rest.
 */

export type ApiKeyPrincipal = Extract<ApiPrincipal, { kind: "api-key" }>;

/** What a tool did: data for the model, or a message that tells it why not (an MCP tool error, not a protocol error). */
export type ToolOutcome =
  | {
      ok: true;
      data: Record<string, unknown>;
      /** Send `data` as the JSON text only, not again as `structuredContent` (a large list, #896). */
      textOnly?: true;
    }
  /** Markdown text for the model, sent as the content text itself (not JSON), with no `structuredContent`. */
  | { ok: true; markdown: string }
  | { ok: false; message: string };

export type McpTool = {
  name: string;
  description: string;
  readOnly: boolean;
  /** A write that cannot be undone (MCP's `destructiveHint`). */
  destructive?: boolean;
  /** The API key permission a call needs. */
  permission: ApiKeyPermission;
  input: z.ZodObject;
  run(principal: ApiKeyPrincipal, args: never, ctx: McpContext): Promise<ToolOutcome>;
};

/** What the server knows about the call itself: the Panel's own origin, so a Task's watch URL is absolute. */
export type McpContext = { origin: string };

/** A v1 handler's `Response` as a tool outcome: 2xx is its JSON, anything else is `"<status> <error>"`. */
async function outcomeOf(response: Response): Promise<ToolOutcome> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return { ok: true, data: body };
  const reason = typeof body.error === "string" ? body.error : "failed";
  // A refusal with a stable `code` (an Agent's harness check) leads with it: the model can tell "wait" from "missing".
  const code = typeof body.code === "string" ? `${body.code}: ` : "";
  return { ok: false, message: `${response.status} ${code}${reason}` };
}

/** The JSON body a v1 write handler reads, as the `Request` it takes: the tool's arguments are its body, validated by the same schema. */
function asJsonRequest(body: Record<string, unknown>, method = "POST"): Request {
  return new Request("http://mcp.invalid/", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tool<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  readOnly: boolean;
  destructive?: boolean;
  permission: ApiKeyPermission;
  input: S;
  run: (principal: ApiKeyPrincipal, args: z.infer<S>, ctx: McpContext) => Promise<ToolOutcome>;
}): McpTool {
  return def as McpTool;
}

const taskIdArg = z.string().min(1).describe("The Task's id, from get_tasks.");
const timeoutMinutesArg = z
  .number()
  .int()
  .min(1)
  .max(43200)
  .nullable()
  .optional()
  .describe("Time limit in minutes per attempt (1–43200). Omit for 60; null = No limit: the attempt runs until the agent reports or exits.");
const autoRetryArg = z
  .object({ maxAttempts: z.number().int().min(1).max(3).describe("Attempts the Task may have in all, 1 to 3.") })
  .nullable()
  .optional()
  .describe("Opt in to auto-retry: if its Session dies without a result, the Task is assigned again after 1, 5, then 15 minutes, up to maxAttempts. Omit = off (null turns it off). The Panel's ceiling can lower it; the answer's autoRetryClamped says so.");
const coreIdArg = z.string().min(1).describe("A Core's id, from list_cores.");
const agentIdArg = z.string().min(1).describe("An Agent's id, from list_agents.");
const agentNameArg = z.string().describe(`The Agent's name: one line of at most ${AGENT_NAME_MAX} characters, unique on its Core.`);
const agentModelArg = z
  .string()
  .nullable()
  .optional()
  .describe("A model id for the harness (letters, digits and . _ : / @ + -), e.g. opus. null or omitted = the harness's own default.");
const agentFlagsArg = z
  .array(z.string())
  .optional()
  .describe(`Flags from this closed set: ${AGENT_FLAGS.join(", ")}. Nothing else is accepted: an Agent has no command, arguments, script or environment.`);

export const MCP_TOOLS: readonly McpTool[] = [
  tool({
    name: "get_guide",
    description:
      "How to use the Task tools: hand a Task to a named Agent, wait for it, read each sessionState, and comment or re-assign. Returns Markdown. " +
      `Call it first. With no topic it returns the overview and the topic list; topic is one of ${GUIDE_TOPICS.join(", ")}.`,
    readOnly: true,
    permission: "read",
    input: z.object({ topic: z.enum(GUIDE_TOPICS).optional().describe("One guide topic. Omit for the overview and the topic list.") }),
    run: async (_principal, { topic }) => ({ ok: true, markdown: guideMarkdown(topic) }),
  }),
  tool({
    name: "list_cores",
    description:
      "List the Cores this API key can reach, with their connection state and capacity: liveSessions (harness PTYs running now, null when the Core cannot be asked) against maxSessions (the limit; a Core refuses new Sessions at it).",
    readOnly: true,
    permission: "read",
    input: z.object({}),
    run: async (principal) => outcomeOf(await listCoresV1(principal)),
  }),
  tool({
    name: "list_agents",
    description: "List the Agents (a named harness and its settings on one Core) the key can reach, optionally on one Core.",
    readOnly: true,
    permission: "read",
    input: z.object({ coreId: coreIdArg.optional() }),
    run: async (principal, { coreId }) =>
      outcomeOf(coreId === undefined ? await listAgentsV1(principal) : await listCoreAgentsV1(principal, coreId)),
  }),
  tool({
    name: "create_agent",
    description:
      "Create an Agent: a named harness with a model and flags on one Core. The Core must be online and report the harness ready. " +
      "Refusals are 409 and start with a code: core_harnesses_unavailable (the Core cannot be asked right now: it is offline, try again later), " +
      "harness_not_ready (the Core is still checking the harness: ask again shortly), " +
      "harness_missing_on_core (not available there: it is not installed, outdated or needs setup).",
    readOnly: false,
    permission: "agents:write",
    input: z.strictObject({
      coreId: coreIdArg,
      name: agentNameArg,
      harness: z.enum(HARNESSES).describe("The harness this Agent runs, e.g. claude-code."),
      model: agentModelArg,
      flags: agentFlagsArg,
    }),
    run: async (principal, args) => outcomeOf(await createAgentV1(principal, asJsonRequest(args))),
  }),
  tool({
    name: "update_agent",
    description:
      "Change an Agent's name, model and/or flags in place: its id stays, so briefs and Tasks that name it keep working, and the next Task sent to it runs with the new settings. " +
      "A field you leave out is kept; model null clears the model. The harness and the Core cannot be changed, and a default Agent (one a Core made for itself) is refused with 409.",
    readOnly: false,
    permission: "agents:write",
    input: z
      .strictObject({ agentId: agentIdArg, name: agentNameArg.optional(), model: agentModelArg, flags: agentFlagsArg })
      .refine((a) => a.name !== undefined || a.model !== undefined || a.flags !== undefined, {
        message: "give a name, a model or flags",
      }),
    run: async (principal, { agentId, ...fields }) => outcomeOf(await updateAgentV1(principal, agentId, asJsonRequest(fields, "PATCH"))),
  }),
  tool({
    name: "delete_agent",
    description:
      "Delete an Agent. A default Agent (one a Core made for itself) is refused with 409. Tasks that named the Agent keep their text; they cannot be sent to it again.",
    readOnly: false,
    permission: "agents:write",
    destructive: true,
    input: z.strictObject({ agentId: agentIdArg }),
    run: async (principal, { agentId }) => {
      const deleted = await outcomeOf(await deleteAgentV1(principal, agentId));
      return deleted.ok ? { ok: true, data: { deleted: agentId } } : deleted;
    },
  }),
  tool({
    name: "get_tasks",
    description:
      "List Tasks on the Cores the key can reach, optionally only one status or one Core. List with get_tasks, read one Task's brief with get_task: rows are lean (id, title, status, coreId, agent, attemptCount, timeoutMinutes, createdAt, updatedAt, sessionState and the rest) and never carry the description. " +
      "With no limit, every matching Task. With a limit (1-100) you get one page, newest update first, plus nextCursor: pass it back as cursor for the next page; null on the last. " +
      `withDescriptions: true adds each description, only together with a limit of ${TASKS_WITH_DESCRIPTIONS_MAX_LIMIT} or less. Each Task has waiting: { reason, coreId } while it is assigned but not started (Core full, Core not connected, Harness not ready), else null. ` +
      "Each Task has sessionState (working, needs-input, interrupted, idle-no-result, exited; null when no attempt runs): pass sessionState (one value or a comma list) to list only those, e.g. every Task that needs-input. " +
      "A row has no watch URL: read it with get_task, or wait on the watch.url that create_task, assign_task and comment_task returned. Call get_guide for the full recipe.",
    readOnly: true,
    permission: "read",
    input: z.object({
      status: z.enum(TASK_STATUSES).optional(),
      coreId: coreIdArg.optional(),
      limit: z.number().int().min(1).max(TASKS_PAGE_MAX_LIMIT).optional().describe("Page size, 1-100. Omit to get every matching Task (lean rows)."),
      cursor: z.string().min(1).optional().describe("The nextCursor of the previous page. Needs limit."),
      withDescriptions: z
        .boolean()
        .optional()
        .describe(`true adds each Task's description. Refused unless limit is ${TASKS_WITH_DESCRIPTIONS_MAX_LIMIT} or less. Default false: a list never carries briefs, read one with get_task.`),
      sessionState: z
        .string()
        .optional()
        .describe(`Only Tasks whose Session is in this state: one of ${TASK_SESSION_STATES.join(", ")}, or a comma list of them.`),
    }),
    run: async (principal, { status, coreId, limit, cursor, sessionState, withDescriptions }) => {
      if (coreId !== undefined && !scopeReaches(principal.scope, coreId)) {
        return outcomeOf(forbidden("this API key does not reach that Core"));
      }
      const listed = await outcomeOf(
        await listTasksV1(principal, {
          ...(status === undefined ? {} : { status }),
          ...(coreId === undefined ? {} : { coreId }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(sessionState === undefined ? {} : { sessionState }),
          ...(withDescriptions ? { withDescriptions: true } : {}),
          lean: true,
        }),
      );
      // The rows are in the JSON text only: a list can be megabytes, so it is not repeated as structuredContent.
      return listed.ok ? { ...listed, textOnly: true } : listed;
    },
  }),
  tool({
    name: "get_sessions",
    description:
      "List one Core's Sessions, one page at a time: running and waiting-for-input first, then newest activity. Lean rows (id, title, harness, status, pinned, archived, live, updatedAt): no prompt text, no transcript. " +
      "Pass the returned nextCursor back as cursor for the next page; it is null on the last. total counts every Session the filters match on that Core.",
    readOnly: true,
    permission: "read",
    input: z.object({
      coreId: coreIdArg,
      limit: z.number().int().min(1).max(SESSION_PAGE_MAX).optional().describe("Page size, 1-100. Default 25."),
      cursor: z.string().min(1).optional().describe("The nextCursor of the previous page."),
      status: z.enum(SESSION_STATUS_FILTERS).optional().describe("Only Sessions in this state."),
      archived: z.boolean().optional().describe("true lists archived Sessions instead of active ones."),
      harness: z.string().min(1).optional().describe("Only Sessions of this harness, e.g. claude-code."),
      q: z.string().min(1).optional().describe("Only Sessions whose name contains this text."),
    }),
    run: async (principal, args) => {
      const listed = await outcomeOf(await listSessionsV1(principal, args));
      return listed.ok ? { ...listed, textOnly: true } : listed;
    },
  }),
  tool({
    name: "get_task",
    description:
      "One Task with its comment thread (the agent's report arrives here as a comment). waiting is { reason, coreId } while the Task is assigned but not started (Core full, Core not connected, Harness not ready), else null. " +
      "sessionState says what its Session is doing; while an attempt is assigned (queued) or runs, watch is { url, expiresAt, pollAfterSeconds }: wait by reading watch.url (no API key), not by calling get_task in a loop. " +
      "While sessionState is needs-input the Task has prompt: { text, options?, kind, at }, what the Session asks (null when its Core cannot be read): answer it with answer_task. Call get_guide for the full recipe.",
    readOnly: true,
    permission: "read",
    input: z.object({ taskId: taskIdArg }),
    run: async (principal, { taskId }, { origin }) => outcomeOf(await getTaskV1(principal, taskId, origin)),
  }),
  tool({
    name: "create_task",
    description:
      "Create a Task. It is a draft unless startNow is true, which creates it assigned so its Agent starts on it (needs coreId and agent). If the Core is full or not connected the Task is queued: the answer says so (queued, waiting) and it starts by itself. " +
      "timeoutMinutes sets its time limit per attempt (default 60 minutes; null = No limit). " +
      "autoRetry { maxAttempts: 1-3 } opts in to auto-retry when its Session dies without a result (default off); set fromTaskId to your own Task's id when your Session creates a Resume or hand-over Task. " +
      "The Task comes back with sessionState and, watch.url right away, even while it is queued for a Core: read that URL to wait (it needs no API key); do not loop on get_task or call it again. A draft has no watch. Call get_guide for the full recipe.",
    readOnly: false,
    permission: "tasks:write",
    input: z.object({
      title: z.string().min(1).describe("A short title."),
      description: z.string().optional().describe("What to do, in Markdown."),
      coreId: coreIdArg.nullable().optional(),
      agent: z.string().min(1).nullable().optional().describe("An Agent's id on that Core, from list_agents."),
      startNow: z.boolean().optional(),
      timeoutMinutes: timeoutMinutesArg,
      autoRetry: autoRetryArg,
      fromTaskId: z.string().min(1).optional().describe("The id of your own Task, set it when your Session creates a Resume / hand-over Task."),
    }),
    run: async (principal, args, { origin }) => outcomeOf(await createTaskV1(principal, asJsonRequest(args), origin)),
  }),
  tool({
    name: "assign_task",
    description:
      "Move a Task to assigned (its Agent starts on it) or back to draft. These are the only moves an operator makes; " +
      "in_progress, done, failed and partial belong to the dispatcher and the Agent's report. A Task that is in_progress " +
      "cannot be moved: stop_task it first. autoRetry { maxAttempts: 1-3 } (null = off) is applied with the move. The Task comes back with sessionState and, watch.url straight away (no extra get_task) to wait on; a Task moved back to draft has none.",
    readOnly: false,
    permission: "tasks:write",
    input: z.object({ taskId: taskIdArg, status: z.enum(OPERATOR_TASK_STATUSES).default("assigned"), autoRetry: autoRetryArg }),
    run: async (principal, { taskId, status, autoRetry }, { origin }) =>
      outcomeOf(await setTaskStatusV1(principal, taskId, asJsonRequest({ status, ...(autoRetry === undefined ? {} : { autoRetry }) }), origin)),
  }),
  tool({
    name: "comment_task",
    description: "Add a comment to a Task's thread. It is a note: nothing is typed into the Task's Session unless you pass deliver \"now\", which also types it into the running Session mid-turn " +
      "(refused, and kept as a note with the reason in the answer's delivery, when the Session is waiting for input). Do not use deliver on your own Task. " +
      "With reassign true, also send a finished Task back to its Agent (Comment & re-assign) and get the Task back with sessionState and watch.url straight away. " +
      "reassign is refused for a Task that is in_progress: stop_task it first, then comment again with reassign true.",
    readOnly: false,
    permission: "tasks:write",
    input: z.object({
      taskId: taskIdArg,
      body: z.string().min(1),
      reassign: z.boolean().optional(),
      deliver: z.literal("now").optional().describe("now: also type the comment into the Task's running Session. Without it the comment is a note."),
    }),
    run: async (principal, { taskId, body, reassign, deliver }, { origin }) =>
      outcomeOf(
        await addTaskCommentV1(
          principal,
          taskId,
          asJsonRequest({ body, ...(reassign === undefined ? {} : { reassign }), ...(deliver === undefined ? {} : { deliver }) }),
          origin,
        ),
      ),
  }),
  tool({
    name: "answer_task",
    description:
      "Answer the prompt a Task's Session waits at (sessionState needs-input; read it with get_task: prompt { text, options?, kind, at }). " +
      "answer is { text } (typed, then Enter), { option } (a number from 1, or a label) or { keys } from a fixed list (Enter, Esc, Up, Down, Left, Right, Tab, Space, y, n, 1-9). " +
      "Pass expect = the prompt.at you read: a different or already answered prompt is refused with stale_prompt. On an unknown prompt only keys is accepted. " +
      "Refusals type nothing and start with the HTTP status and a code: not_waiting, stale_prompt, invalid_answer, prompt_unavailable, and needs_human for a trust, password, token or credential prompt or a permission that would widen the Agent's access: ask a human, never find another way to type it. " +
      "Each answer adds a Task comment. Call get_guide with topic states for the recipe.",
    readOnly: false,
    permission: "tasks:write",
    input: z.object({
      taskId: taskIdArg,
      answer: answerTaskBody.shape.answer,
      expect: z.number().int().optional().describe("The prompt.at you read with get_task."),
    }),
    run: async (principal, { taskId, answer, expect }, { origin }) =>
      outcomeOf(await answerTaskV1(principal, taskId, asJsonRequest({ answer, ...(expect === undefined ? {} : { expect }) }), origin)),
  }),
  tool({
    name: "stop_task",
    description:
      "Stop a Task that is in_progress: stops its Session, fails it with a system comment; then comment_task reassign works. " +
      "The result says whether the Session was stopped (a Core that is offline leaves it running).",
    readOnly: false,
    permission: "tasks:write",
    destructive: true,
    input: z.object({ taskId: taskIdArg, reason: z.string().max(2000).optional().describe("Why it is stopped; recorded in the Task's comment.") }),
    run: async (principal, { taskId, reason }, { origin }) =>
      outcomeOf(await stopTaskV1(principal, taskId, asJsonRequest({ ...(reason === undefined ? {} : { reason }) }), origin)),
  }),
  tool({
    name: "close_session",
    description:
      "End the harness of a Task that is no longer in_progress (done, partial, failed) and free its Core's PTY slot, so a Task waiting for capacity starts. " +
      "The Session stays: its transcript is kept and a comment_task with reassign continues it. Refused with 409 for a Task that is in_progress (use stop_task), " +
      "for a Task with no Session, and for a Session someone is working in (a terminal is attached).",
    readOnly: false,
    permission: "tasks:write",
    destructive: true,
    input: z.object({ taskId: taskIdArg }),
    run: async (principal, { taskId }, { origin }) => outcomeOf(await closeTaskSessionV1(principal, taskId, origin)),
  }),
  tool({
    name: "update_task",
    description:
      "Change a Task's title, description, time limit, autoRetry ({ maxAttempts: 1-3 }; null = off) or any of them. The title and description are refused while the " +
      "Task is in_progress, because its Session already has the prompt; the time limit can be changed at any status, " +
      "including in_progress, and applies to the running attempt within a minute.",
    readOnly: false,
    permission: "tasks:write",
    input: z
      .object({
        taskId: taskIdArg,
        title: z.string().min(1).optional().describe("The new title."),
        description: z.string().optional().describe("The new description, in Markdown. It replaces the old one."),
        timeoutMinutes: timeoutMinutesArg,
        autoRetry: autoRetryArg,
      })
      .refine((a) => a.title !== undefined || a.description !== undefined || a.timeoutMinutes !== undefined || a.autoRetry !== undefined, {
        message: "give a title, a description, a time limit or autoRetry",
      }),
    run: async (principal, { taskId, ...fields }, { origin }) =>
      outcomeOf(await updateTaskV1(principal, taskId, asJsonRequest(fields, "PATCH"), origin)),
  }),
  tool({
    name: "delete_task",
    description:
      "Delete a Task with its comments and history. Refused while the Task is in_progress; files it left in the Shared " +
      "folder stay.",
    readOnly: false,
    permission: "tasks:write",
    destructive: true,
    input: z.object({ taskId: taskIdArg }),
    run: async (principal, { taskId }) => {
      const deleted = await outcomeOf(await deleteTaskV1(principal, taskId));
      return deleted.ok ? { ok: true, data: { deleted: taskId } } : deleted;
    },
  }),
  tool({
    name: "list_shared",
    description:
      "List a folder in a Core's Shared folder (read-only), where Agents leave their results. path is relative to the " +
      "Shared folder, with no .. and no leading /; omit it for the top.",
    readOnly: true,
    permission: "read",
    input: z.object({ coreId: coreIdArg, path: z.string().optional() }),
    run: (principal, args) => listShared(principal, args),
  }),
  tool({
    name: "get_shared",
    description:
      "Read one text file from a Core's Shared folder (read-only). path is relative to the Shared folder, with no .. and no " +
      "leading /. A file over 256 KiB is refused.",
    readOnly: true,
    permission: "read",
    input: z.object({ coreId: coreIdArg, path: z.string() }),
    run: (principal, args) => getShared(principal, args),
  }),
];
