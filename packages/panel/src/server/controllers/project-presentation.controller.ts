import { z } from "zod";
import {
  deleteProjectPresentation,
  listProjectPresentation,
  pruneProjectPresentation,
  upsertProjectPresentation,
} from "../services/project-presentation";
import { idParam, json, noContent, notFound, parseJsonBody } from "./_helpers";

const upsertBody = z
  .object({
    coreId: z.string().min(1),
    groupId: z.string().nullable().optional(),
    imagePath: z.string().nullable().optional(),
    launchUrl: z.string().nullable().optional(),
  });

const pruneBody = z.object({
  coreId: z.string().min(1),
  projectIds: z.array(z.string().min(1)),
});

export async function list(): Promise<Response> {
  return json({ presentation: listProjectPresentation() });
}

export async function upsert(rawId: string, request: Request): Promise<Response> {
  const idParsed = idParam.safeParse(rawId);
  if (!idParsed.success) return notFound();
  const parsed = await parseJsonBody(request, upsertBody);
  if (!parsed.ok) return parsed.response;
  const { coreId, ...patch } = parsed.data;
  return json({ presentation: upsertProjectPresentation(idParsed.data, coreId, patch) });
}

export async function remove(rawId: string): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  // Idempotent: removing a project deletes its filing, and the caller should
  // not have to know whether it had any.
  deleteProjectPresentation(parsed.data);
  return noContent();
}

/**
 * Sweep the filing for projects a Core no longer has. The Panel cannot ask the
 * Core itself — the core-link is the browser's transport, not the server's —
 * so the client posts the list it just read and the server keeps only those.
 */
export async function prune(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, pruneBody);
  if (!parsed.ok) return parsed.response;
  const removed = pruneProjectPresentation(parsed.data.coreId, parsed.data.projectIds);
  return json({ removed });
}
