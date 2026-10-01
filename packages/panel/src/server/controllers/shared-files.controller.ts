import { z } from "zod";
import { json, jsonError, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { HTTP_BAD_REQUEST, HTTP_PAYLOAD_TOO_LARGE } from "~/shared/http-status";
import { PayloadTooLargeError, sharedFiles } from "../services/shared-files";

/**
 * The Files tab's routes, `/api/cores/:coreId/shared/files…` (#565). Each one takes the owner the session runs as and a
 * Core id, and hands both to the service: nothing here builds an S3 request, holds a key or decides what a path means.
 * What a browser gets back is entries, text and one signed download URL, never a credential of the Panel's.
 */

const pathBody = z.object({ path: z.string() });
const renameBody = z.object({ path: z.string(), name: z.string() });
const moveBody = z.object({ path: z.string(), to: z.string() });

/** The domain's refusals become their status; a file over the limit is a 413. */
function refusal(err: unknown): Response {
  if (err instanceof PayloadTooLargeError) return jsonError(HTTP_PAYLOAD_TOO_LARGE, err.message, { "x-upload-limit": String(err.limitBytes) });
  return rethrowUnlessDomain(err);
}

async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return refusal(err);
  }
}

export const list = (ownerId: number, coreId: string, url: URL) =>
  guarded(async () => json(await sharedFiles().list(ownerId, coreId, url.searchParams.get("path") ?? "")));

export const details = (ownerId: number, coreId: string, url: URL) =>
  guarded(async () => json(await sharedFiles().details(ownerId, coreId, url.searchParams.get("path") ?? "")));

export const search = (ownerId: number, coreId: string, url: URL) =>
  guarded(async () => json(await sharedFiles().search(ownerId, coreId, url.searchParams.get("q") ?? "")));

export const summary = (ownerId: number, coreId: string, url: URL) =>
  guarded(async () => {
    const since = Number(url.searchParams.get("since") ?? "0");
    return json(await sharedFiles().summary(ownerId, coreId, Number.isFinite(since) && since > 0 ? since : 0));
  });

/** An image or a PDF for the details pane and the tiles, streamed through the Panel: the browser has no S3 address. */
export const media = (ownerId: number, coreId: string, url: URL) =>
  guarded(async () => {
    const file = await sharedFiles().media(ownerId, coreId, url.searchParams.get("path") ?? "");
    return new Response(file.body as BodyInit, {
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.body.byteLength),
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });

export const downloadUrl = (ownerId: number, coreId: string, request: Request) =>
  guarded(async () => {
    const body = await parseJsonBody(request, pathBody);
    if (!body.ok) return body.response;
    return json(await sharedFiles().downloadUrl(ownerId, coreId, body.data.path), { headers: { "cache-control": "no-store" } });
  });

export const mkdir = (ownerId: number, coreId: string, request: Request) =>
  guarded(async () => {
    const body = await parseJsonBody(request, pathBody);
    if (!body.ok) return body.response;
    return json(await sharedFiles().mkdir(ownerId, coreId, body.data.path));
  });

/** The browser's stream is handed on unread: the service counts it against the limit as it arrives. */
export const upload = (ownerId: number, coreId: string, url: URL, request: Request) =>
  guarded(async () => {
    if (!request.body) return jsonError(HTTP_BAD_REQUEST, "this upload carried no body");
    const declared = request.headers.get("content-length");
    const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
    return json({ entry: await sharedFiles().upload(ownerId, coreId, url.searchParams.get("path") ?? "", request.body, length) });
  });

export const rename = (ownerId: number, coreId: string, request: Request) =>
  guarded(async () => {
    const body = await parseJsonBody(request, renameBody);
    if (!body.ok) return body.response;
    return json(await sharedFiles().rename(ownerId, coreId, body.data.path, body.data.name));
  });

export const move = (ownerId: number, coreId: string, request: Request) =>
  guarded(async () => {
    const body = await parseJsonBody(request, moveBody);
    if (!body.ok) return body.response;
    return json(await sharedFiles().move(ownerId, coreId, body.data.path, body.data.to));
  });

export const remove = (ownerId: number, coreId: string, request: Request) =>
  guarded(async () => {
    const body = await parseJsonBody(request, pathBody);
    if (!body.ok) return body.response;
    await sharedFiles().remove(ownerId, coreId, body.data.path);
    return json({ ok: true });
  });
