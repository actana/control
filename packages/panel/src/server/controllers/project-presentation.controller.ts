import { z } from "zod";
import {
  deleteProjectPresentation,
  listProjectPresentation,
  pruneProjectPresentation,
  reorderCorePins,
  upsertProjectPresentation,
} from "../services/project-presentation";
import { idParam, json, noContent, notFound, parseJsonBody } from "./_helpers";

const upsertBody = z
  .object({
    coreId: z.string().min(1),
    groupId: z.string().nullable().optional(),
    imagePath: z.string().nullable().optional(),
    launchUrl: z.string().nullable().optional(),
    pinnedOrder: z.number().int().nullable().optional(),
  });

// The rail slots of every Core-owned pin on the rail (issue 382). Slots are
// indices into the whole rail, the same sequence `PATCH /api/projects/
// pinned-order` numbers the Panel's own rows from — not a second numbering
// that would have to be reconciled on read.
const corePinOrderBody = z.object({
  order: z.array(
    z.object({
      projectId: z.string().min(1),
      coreId: z.string().min(1),
      pinnedOrder: z.number().int().min(0),
    }),
  ),
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

/**
 * Persist where every Core-owned pin sits on the rail. One request for the
 * whole set: the slots only mean anything together, and a reorder that landed
 * some of them would leave the rail in an order the operator never chose.
 */
export async function reorderPinned(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, corePinOrderBody);
  if (!parsed.ok) return parsed.response;
  return json({ presentation: reorderCorePins(parsed.data.order) });
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
