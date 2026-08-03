import { z } from "zod";
import { TASK_AGENTS } from "@actana/shared/domain";
import {
  createProject,
  deleteProject,
  getProject,
  getProjectPathStatus,
  listProjects,
  togglePin,
  updateProject,
  reorderPinnedProjects,
} from "../services/projects";
import {
  rethrowUnlessDomain,
  idParam,
  json,
  jsonError,
  noContent,
  notFound,
  parseJsonBody,
} from "./_helpers";
import {
  HTTP_BAD_REQUEST,
  HTTP_CREATED,
  HTTP_INTERNAL_SERVER_ERROR,
} from "~/shared/http-status";
import {
  MAX_IMAGE_BYTES,
  clearProjectImage,
  readProjectImage,
  writeProjectImage,
} from "../services/project-images";
import {
  projectImageExtensionFor,
  MAX_PROJECT_IMAGE_BYTES,
} from "~/shared/project-image-limits";

const createProjectBody = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  githubUrl: z.string().optional(),
  icon: z.string().optional(),
  iconColor: z.string().optional(),
  groupId: z.string().nullable().optional(),
  // Create-time onboarding: default agent + layout for the new project.
  savedAgent: z.enum(TASK_AGENTS).nullable().optional(),
  rememberAgentSettings: z.boolean().optional(),
  defaultGridView: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

const updateProjectBody = z
  .object({
    name: z.string(),
    path: z.string(),
    icon: z.string(),
    iconColor: z.string(),
    imagePath: z.string().nullable(),
    groupId: z.string().nullable(),
    pinned: z.boolean(),
    launchUrl: z.string().nullable(),
    rememberAgentSettings: z.boolean(),
    savedAgent: z.enum(TASK_AGENTS).nullable(),
    savedSkipPermissions: z.boolean(),
    savedBareSession: z.boolean(),
    togglePin: z.literal(true).optional(),
  })
  .partial();

const reorderPinnedBody = z.object({
  order: z.array(z.string().min(1)),
});

export async function list(request: Request): Promise<Response> {
  return json({ projects: listProjects() });
}

export async function create(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, createProjectBody);
  if (!parsed.ok) return parsed.response;
  try {
    if (!parsed.data.path?.trim()) {
      return jsonError(HTTP_BAD_REQUEST, "path is required");
    }
    const localPath = parsed.data.path.trim();
    const { githubUrl: _ignored, ...localProject } = parsed.data;
    const p = createProject({ ...localProject, path: localPath });
    return json({ project: p }, { status: HTTP_CREATED });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function getOne(rawId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const id = parsed.data;
  const p = getProject(id);
  if (!p) return notFound();
  return json({ project: p });
}

export async function pathStatus(rawId: string): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const status = getProjectPathStatus(parsed.data);
  return status ? json({ status }) : notFound();
}

export async function reorderPinned(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, reorderPinnedBody);
  if (!parsed.ok) return parsed.response;
  try {
    return json({ projects: reorderPinnedProjects(parsed.data.order) });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function update(rawId: string, request: Request): Promise<Response> {
  const idParsed = idParam.safeParse(rawId);
  if (!idParsed.success) return notFound();
  const id = idParsed.data;
  const parsed = await parseJsonBody(request, updateProjectBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (body.togglePin === true) {
    const pinned = togglePin(id);
    if (!pinned) return notFound();
    return json({ project: pinned });
  }
  const { togglePin: _ignored, ...patch } = body;
  try {
    const p = updateProject(id, patch);
    if (!p) return notFound();
    return json({ project: p });
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

export async function remove(rawId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  return deleteProject(parsed.data) ? noContent() : notFound();
}

// ── Project card image ──────────────────────────────────────────────────────
//
// The browser uploads bytes and reads them back over HTTP. There is no native
// picker and no `app://` protocol to serve them from (ADR 0010): the operator's
// machine only ever hands us a File, never a path.

export async function getImage(rawId: string): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const project = getProject(parsed.data);
  if (!project) return notFound();
  const image = readProjectImage(project);
  if (!image) return notFound();
  return new Response(image.bytes as unknown as BodyInit, {
    headers: {
      "content-type": image.contentType,
      // We serve back only what we accepted, but the bytes themselves are
      // operator-supplied — never let a browser sniff its way to another type.
      "x-content-type-options": "nosniff",
      // The URL carries a `v=` cache-buster keyed on updatedAt, so the bytes at
      // a given URL never change and can be cached hard.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

export async function putImage(rawId: string, request: Request): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const id = parsed.data;
  if (!getProject(id)) return notFound();

  const extension = projectImageExtensionFor(request.headers.get("content-type"));
  if (!extension) return jsonError(HTTP_BAD_REQUEST, "unsupported image type");

  // Refuse on the declared length before reading anything: buffering the body
  // first would let an oversized upload cost us the memory we are rejecting it
  // for. The post-read check below still stands — `content-length` is the
  // client's claim, not a fact.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PROJECT_IMAGE_BYTES) {
    return jsonError(HTTP_BAD_REQUEST, "image too large");
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return jsonError(HTTP_BAD_REQUEST, "could not read the uploaded image");
  }
  if (bytes.byteLength === 0) return jsonError(HTTP_BAD_REQUEST, "empty image");
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return jsonError(HTTP_BAD_REQUEST, "image too large");
  }

  try {
    const project = writeProjectImage(id, extension, bytes);
    return project ? json({ project }) : notFound();
  } catch {
    // Disk full, permissions, a read-only data dir — the operator needs to know
    // the image did not land, not a bare 500.
    return jsonError(
      HTTP_INTERNAL_SERVER_ERROR,
      "could not save the image — check the Panel's data directory",
    );
  }
}

export async function removeImage(rawId: string): Promise<Response> {
  const parsed = idParam.safeParse(rawId);
  if (!parsed.success) return notFound();
  const project = clearProjectImage(parsed.data);
  return project ? json({ project }) : notFound();
}
