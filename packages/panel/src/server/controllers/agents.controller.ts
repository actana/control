import { z } from "zod";
import { json, noContent, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { NotFoundError } from "../errors";
import { HTTP_CREATED } from "~/shared/http-status";
import { HARNESSES } from "~/shared/agents";
import { createAgent, deleteAgent, getAgent, updateAgent, type Agent } from "../services/agents";
import { findCoreById } from "../repositories/cores.repo";
import { agentChangesBody, agentWriteError } from "./v1.controller";
import { agentDto } from "./tasks.controller";

/**
 * The signed-in owner's Agent routes (#893): create, change and delete one
 * Agent of one Core, in the Core's path. Every call runs as the session's
 * owner through the Agents service, which owns the rules; an Agent that is not
 * on the Core in the path is a 404, like one that is not the owner's. The error
 * `code`s are the v1 routes' (`agentWriteError`).
 *
 * The create body is strict: a field that is not name, harness, model or flags
 * (a command, arguments, an environment, a Core) is a 400 rather than dropped.
 */
const newAgentBody = z.strictObject({
  name: z.string(),
  harness: z.enum(HARNESSES),
  model: z.string().nullable().optional(),
  flags: z.array(z.string()).optional(),
});

/** The Agent, only when it is the owner's and sits on this Core. */
async function agentOnCore(ownerId: number, coreId: string, agentId: string): Promise<Agent> {
  const agent = await getAgent(ownerId, agentId);
  if (agent.coreId !== coreId) throw new NotFoundError("agent not found");
  return agent;
}

export async function create(ownerId: number, coreId: string, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, newAgentBody);
  if (!body.ok) return body.response;
  try {
    const agent = await createAgent(ownerId, {
      coreId,
      name: body.data.name,
      harness: body.data.harness,
      ...(body.data.model === undefined ? {} : { model: body.data.model }),
      ...(body.data.flags === undefined ? {} : { flags: body.data.flags }),
    });
    return json({ agent: agentDto(agent) }, { status: HTTP_CREATED });
  } catch (e) {
    return agentWriteError(e);
  }
}

export async function update(ownerId: number, coreId: string, agentId: string, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, agentChangesBody);
  if (!body.ok) return body.response;
  try {
    if (!(await findCoreById(ownerId, coreId))) throw new NotFoundError("core not found");
    await agentOnCore(ownerId, coreId, agentId);
    return json({ agent: agentDto(await updateAgent(ownerId, agentId, body.data)) });
  } catch (e) {
    return agentWriteError(e);
  }
}

export async function remove(ownerId: number, coreId: string, agentId: string): Promise<Response> {
  try {
    if (!(await findCoreById(ownerId, coreId))) throw new NotFoundError("core not found");
    await agentOnCore(ownerId, coreId, agentId);
    await deleteAgent(ownerId, agentId);
    return noContent();
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}
