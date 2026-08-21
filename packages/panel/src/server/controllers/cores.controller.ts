import { z } from "zod";
import { json, noContent, notFound, parseJsonBody } from "./_helpers";
import { HTTP_BAD_REQUEST, HTTP_CREATED } from "~/shared/http-status";
import { listCores, removeCore, renameCore } from "../services/cores";
import {
  CorePairingRefusedError,
  inspectCoreForPairing,
  pairCore,
} from "../services/core-pairing";
import { coreLinkManager } from "../services/core-link-manager";
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

function withDial(core: Core): CoreWithDial {
  return { ...core, dial: coreLinkManager().status(core.id) };
}

export function list(): Response {
  return json({ cores: listCores().map(withDial) });
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
  coreLinkManager().dial(core.id);
  return json({ core: withDial(core) }, { status: HTTP_CREATED });
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
  const core = renameCore(id, body.data.label);
  if (!core) return notFound("no such Core");
  return json({ core: withDial(core) });
}

/** Forget a Core: hang up first, then drop the registry row, secrets, and cursor. */
export function remove(id: string): Response {
  coreLinkManager().hangup(id);
  if (!removeCore(id)) return notFound("no such Core");
  return noContent();
}
