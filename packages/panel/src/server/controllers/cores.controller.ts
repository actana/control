import { z } from "zod";
import { forbidden, json, noContent, notFound, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { HTTP_BAD_REQUEST, HTTP_CREATED } from "~/shared/http-status";
import { getCore, listCores, removeCore, renameCore } from "../services/cores";
import { scopeReaches } from "../services/api-keys";
import type { ApiPrincipal } from "../api-key-auth";
import {
  CorePairingRefusedError,
  inspectCoreForPairing,
  pairCore,
} from "../services/core-pairing";
import { coreLinkManager } from "../services/core-link-manager";
import { describeSharedFolder, sharedFolders } from "../services/shared-folders";
import { findSharedFolder } from "../repositories/core-shared-folders.repo";
import { OPERATOR_ID } from "../services/operator";
import type { Core, CoreWithDial } from "~/shared/cores";

/**
 * The Cores surface: list the fleet with live link state, add a Core by pairing
 * code, rename one, forget one.
 *
 * **There is no `POST /api/cores`.** A Core enters this Panel by redeeming a
 * short pairing code and no other way; the route that took a pasted
 * registration blob went with the hand-carry it belonged to (#287, #280).
 *
 * Note what is absent — there is no endpoint that returns a Core's secrets, and
 * none that takes them piecemeal. The credentials enter once, inside a
 * credential the service assembles, and from then on only the dialer reads
 * them. The pairing routes hold that line from the other side too: a code goes
 * in, a Core comes back, and the key the Panel now holds was never in either
 * direction of the exchange.
 */

const renameBody = z.object({ label: z.string() });
const inspectBody = z.object({ address: z.string() });
const pairBody = z.object({
  address: z.string(),
  code: z.string(),
  sessionId: z.string().optional(),
  expectedFingerprint: z.string(),
  label: z.string().optional(),
});

/** The row, its live link, and where its Shared folder stands (absent for a Core registered before 0.5.0). */
async function withDial(core: Core): Promise<CoreWithDial> {
  const sharedFolder = await describeSharedFolder(core.id);
  return { ...core, dial: coreLinkManager().status(core.id), ...(sharedFolder ? { sharedFolder } : {}) };
}

/**
 * The Cores a call may see, as the principal it runs as (#572): the Operator's
 * session sees all of its Cores, and an API key sees its owner's Cores inside
 * its scope. A restricted key's list holds only the Cores it was restricted to.
 */
export async function list(principal: ApiPrincipal): Promise<Response> {
  const all = await listCores(principal.ownerId);
  const visible = principal.kind === "api-key" ? all.filter((c) => scopeReaches(principal.scope, c.id)) : all;
  return json({ cores: await Promise.all(visible.map(withDial)) });
}

/** One Core. A key restricted to other Cores gets a 403 whether or not the Core exists, so it learns nothing about it. */
export async function getOne(id: string, principal: ApiPrincipal): Promise<Response> {
  if (principal.kind === "api-key" && !scopeReaches(principal.scope, id)) {
    return forbidden("this API key does not reach that Core");
  }
  const core = await getCore(id, principal.ownerId);
  if (!core) return notFound("no such Core");
  return json({ core: await withDial(core) });
}

/**
 * Report the certificate authority a Core presents, with no code in the
 * request to leak (#286).
 *
 * The first half of the Panel's two-step: the operator is shown this
 * fingerprint beside the one `actana pair new` printed, and only a confirmed
 * comparison moves on to {@link pair}. Answering it costs an unverified dial
 * and nothing else — the connection carries no secret and is dropped as soon
 * as the chain has been read.
 */
export async function inspect(request: Request): Promise<Response> {
  const body = await parseJsonBody(request, inspectBody);
  if (!body.ok) return body.response;
  try {
    return json({ identity: await inspectCoreForPairing(body.data.address) });
  } catch (err) {
    return refusal(err);
  }
}

/**
 * Pair with a Core by short code and register the credential it issues.
 *
 * The dial starts here rather than waiting for a poll, exactly as it does for
 * {@link add}, so the row the operator just paired is already reaching for its
 * Core by the time the response paints.
 *
 * A refusal is a 400 whatever kind it is — including a rate limit. The status
 * describes *this* request to the Panel, which was well-formed; what the Core
 * said is in `failure`, which is the field the page switches on.
 */
export async function pair(request: Request): Promise<Response> {
  const body = await parseJsonBody(request, pairBody);
  if (!body.ok) return body.response;
  let core: Core;
  try {
    core = await pairCore({
      address: body.data.address,
      code: body.data.code,
      ...(body.data.sessionId === undefined ? {} : { sessionId: body.data.sessionId }),
      expectedFingerprint: body.data.expectedFingerprint,
      ...(body.data.label === undefined ? {} : { label: body.data.label }),
    });
  } catch (err) {
    return refusal(err);
  }
  await coreLinkManager().dial(core.id);
  return json({ core: await withDial(core) }, { status: HTTP_CREATED });
}

/**
 * A pairing refusal, as the browser reads it: the sentence under `error` so a
 * generic client shows something useful, and the machine-readable `failure`
 * beside it so the page can say what to do next. Anything that is not a
 * refusal is rethrown for the router to handle.
 */
function refusal(err: unknown): Response {
  if (!(err instanceof CorePairingRefusedError)) throw err;
  return json(err.refusal, { status: HTTP_BAD_REQUEST });
}

/**
 * Rename a Core. A Panel-local write and nothing more — the registry row's
 * label changes, the link is left alone, and the machine is never told.
 *
 * The response carries the label as stored rather than as posted: the service
 * trims it, caps it at 120 characters, and falls back to the endpoint host when
 * it comes out empty, so a client that echoed its own input would show
 * something the Panel doesn't have.
 */
export async function rename(id: string, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, renameBody);
  if (!body.ok) return body.response;
  const core = await renameCore(id, body.data.label);
  if (!core) return notFound("no such Core");
  return json({ core: await withDial(core) });
}

const finishBody = z.object({}).passthrough();
const deleteBody = z.object({ confirmPrefix: z.string() });

/**
 * Test the Shared folder connection (#564, step 4 of the pairing): issue a 1-hour key for this Core and prove it
 * can read, write and list its own folder and cannot reach another Core's. Nothing is stored or sent to the
 * Core; the answer carries the result and when the key would end, never the key.
 */
export async function testSharedFolder(id: string): Promise<Response> {
  try {
    return json({ result: await sharedFolders().testConnection(id) });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}

/**
 * Finish a pairing from the Panel (#564): the last step, the one that cannot be skipped. It repeats the test,
 * attaches the Core's folder and only then reports the Core as paired. Any refusal leaves the Core pending.
 */
export async function finishPairing(id: string, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, finishBody);
  if (!body.ok) return body.response;
  try {
    await sharedFolders().finishPairing(id);
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
  const core = await getCore(id);
  if (!core) return notFound("no such Core");
  return json({ core: await withDial(core) });
}

/**
 * Unpair: tell the Core to let go of S3 (`sharedDetach`, the Core keeps `~/shared` and its contents), hang up, then
 * drop the registry row, secrets and cursor. The S3 prefix is left as it is. Answers 204; a Core that could not
 * be told is still forgotten, and the answer is then a 200 that says so (`detachError`).
 */
export async function remove(id: string): Promise<Response> {
  // A pending folder was never attached: there is nothing to tell the Core.
  const attached = ((await findSharedFolder(OPERATOR_ID, id))?.state ?? "pending") !== "pending";
  const detach = attached ? await sharedFolders().detach(id) : { detached: true };
  coreLinkManager().hangup(id);
  if (!(await removeCore(id))) return notFound("no such Core");
  if (detach.detached) return noContent();
  return json({ detached: false, detachError: detach.error });
}

/**
 * Delete a Core and its Shared folder (#564): the Core row, then its S3 prefix. Only after a confirmation that is
 * exactly the prefix (`sharedFolder.prefix` on the Core, `<prefix>/<core id>/`); anything else is a 409 and nothing is removed.
 */
export async function destroy(id: string, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, deleteBody);
  if (!body.ok) return body.response;
  try {
    return json(await sharedFolders().deleteCore(id, body.data.confirmPrefix));
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}
