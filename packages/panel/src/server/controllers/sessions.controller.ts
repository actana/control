import { z } from "zod";
import { SESSION_STATUSES } from "@actana/shared/domain";
import {
  archiveSession,
  deleteSession,
  getSession,
  restoreSession,
  sweepOrphanedActiveSessions,
  updateStatus,
  updateSession,
} from "../services/sessions";
import { getPendingQuestion } from "../services/pending-questions";
import {
  rethrowUnlessDomain,
  idParam,
  json,
  noContent,
  notFound,
  parseJsonBody,
} from "./_helpers";
import { generateTitleForSession } from "../services/title-generator";

const updateSessionBody = z
  .object({
    title: z.string().trim().min(1, "title required"),
    icon: z.string().nullable(),
    pinned: z.boolean(),
    claudeSessionId: z.string().nullable(),
    titleManuallySet: z.boolean(),
    claudeSkipPermissions: z.boolean(),
    claudeBareSession: z.boolean(),
  })
  .partial();

const updateStatusBody = z.object({
  status: z.enum(SESSION_STATUSES).optional(),
  preview: z.string().optional(),
  lines: z.number().optional(),
  prompt: z.string().optional(),
});

export async function getOne(rawId: string, _request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = await getSession(parsed.data);
  if (!t) return notFound();
  return json({ session: t });
}

export async function readQuestion(rawId: string): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = await getSession(parsed.data);
  if (!t) return notFound();
  return json({ question: getPendingQuestion(parsed.data) });
}

export async function update(rawId: string, request: Request): Promise<Response> {
  const idParsed = idParam.safeParse(rawId);
  if (!idParsed.success) return notFound();
  const parsed = await parseJsonBody(request, updateSessionBody);
  if (!parsed.ok) return parsed.response;
  try {
    const patch = Object.prototype.hasOwnProperty.call(parsed.data, "title")
      ? { ...parsed.data, titleManuallySet: parsed.data.titleManuallySet ?? true }
      : parsed.data;
    const t = await updateSession(idParsed.data, patch);
    if (!t) return notFound();
    return json({ session: t });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function remove(rawId: string, _request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  return (await deleteSession(parsed.data)) ? noContent() : notFound();
}

export async function setStatus(rawId: string, request: Request): Promise<Response> {
  const idParsed = idParam.safeParse(rawId);
  if (!idParsed.success) return notFound();
  const parsed = await parseJsonBody(request, updateStatusBody);
  if (!parsed.ok) return parsed.response;
  try {
    const t = await updateStatus(idParsed.data, parsed.data);
    if (!t) return notFound();
    const prompt = typeof parsed.data.prompt === "string" ? parsed.data.prompt.trim() : "";
    if (prompt) {
      void generateTitleForSession(idParsed.data, prompt).catch(() => undefined);
    }
    return json({ session: t });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function sweepDisconnected(): Promise<Response> {
  return json({ swept: await sweepOrphanedActiveSessions() });
}

export async function archive(rawId: string, _request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = await archiveSession(parsed.data);
  if (!t) return notFound();
  return json({ session: t });
}

export async function restore(rawId: string, _request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = await restoreSession(parsed.data);
  if (!t) return notFound();
  return json({ session: t });
}
