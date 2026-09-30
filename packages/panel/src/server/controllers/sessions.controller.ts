import { z } from "zod";
import { HARNESSES, SESSION_STATUSES } from "@actana/shared/domain";
import {
  archiveSession,
  createSession,
  deleteSession,
  getSession,
  listSessionsForProject,
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
import { HTTP_CREATED } from "~/shared/http-status";
import { generateTitleForSession } from "../services/title-generator";

const createSessionBody = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1, "title required"),
  agent: z.enum(HARNESSES),
  status: z.enum(SESSION_STATUSES).optional(),
  preview: z.string().optional(),
  claudeSessionId: z.string().nullable().optional(),
  claudeSkipPermissions: z.boolean().optional(),
  claudeBareSession: z.boolean().optional(),
});

const updateSessionBody = z
  .object({
    title: z.string().trim().min(1, "title required"),
    icon: z.string().nullable(),
    pinned: z.boolean(),
    claudeSessionId: z.string().nullable(),
    // Whether the `title` beside it is an operator's rename. Absent, a title
    // is one — the shape every rename has always had. A generator sends
    // `false`, matching the Core-side rule (issue 84), so the two arms of one
    // session-mutation frame cannot disagree about what a title means.
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

export async function listForProject(rawProjectId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawProjectId);
  if (!parsed.success) return json({ sessions: [] });
  try {
    return json({ sessions: listSessionsForProject(parsed.data) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function create(rawProjectId: string, request: Request): Promise<Response> {
  const projectIdParsed = idParam.safeParse(rawProjectId);
  if (!projectIdParsed.success) return notFound();
  const parsed = await parseJsonBody(request, createSessionBody);
  if (!parsed.ok) return parsed.response;
  try {
    const t = createSession({
      ...parsed.data,
      projectId: projectIdParsed.data,
    });
    return json({ session: t }, { status: HTTP_CREATED });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function getOne(rawId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = getSession(parsed.data);
  if (!t) return notFound();
  return json({ session: t });
}

export function readQuestion(rawId: string): Response {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = getSession(parsed.data);
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
    const t = updateSession(idParsed.data, patch);
    if (!t) return notFound();
    return json({ session: t });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function remove(rawId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  return deleteSession(parsed.data) ? noContent() : notFound();
}

export async function setStatus(rawId: string, request: Request): Promise<Response> {
  const idParsed = idParam.safeParse(rawId);
  if (!idParsed.success) return notFound();
  const parsed = await parseJsonBody(request, updateStatusBody);
  if (!parsed.ok) return parsed.response;
  try {
    const t = updateStatus(idParsed.data, parsed.data);
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

/**
 * POST /api/sessions/sweep-disconnected — the Panel calls this once per service
 * boot (before the first window) to settle statuses orphaned by the previous
 * run. See sweepOrphanedActiveSessions for the invariant that makes this safe.
 */
export async function sweepDisconnected(): Promise<Response> {
  return json({ swept: sweepOrphanedActiveSessions() });
}

export async function archive(rawId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = archiveSession(parsed.data);
  if (!t) return notFound();
  return json({ session: t });
}

export async function restore(rawId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const t = restoreSession(parsed.data);
  if (!t) return notFound();
  return json({ session: t });
}
