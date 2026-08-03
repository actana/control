import { z } from "zod";
import { json, noContent, notFound, parseJsonBody } from "./_helpers";
import { HTTP_CREATED } from "~/shared/http-status";
import { listCores, registerCoreFromRegistrationBlob, removeCore } from "../services/cores";
import { coreLinkManager } from "../services/core-link-manager";
import type { Core, CoreWithDial } from "~/shared/cores";

/**
 * The Cores surface: list the fleet with live link state, register a new Core
 * from a registration blob, forget one.
 *
 * Note what is absent — there is no endpoint that returns a Core's secrets, and
 * none that takes them piecemeal. The credentials enter once, inside the blob,
 * and from then on only the dialer reads them.
 */

const addBody = z.object({ registrationBlob: z.string() });

function withDial(core: Core): CoreWithDial {
  return { ...core, dial: coreLinkManager().status(core.id) };
}

export function list(): Response {
  return json({ cores: listCores().map(withDial) });
}

/**
 * Register a Core. The dial starts here rather than waiting for a poll, so the
 * row the operator just added is already reaching for its Harness by the time
 * the response paints.
 *
 * A bad blob throws {@link RegistrationBlobError}, which the router turns into
 * a 400 carrying its message — and nothing was written, so there is no
 * half-added Core left behind.
 */
export async function add(request: Request): Promise<Response> {
  const body = await parseJsonBody(request, addBody);
  if (!body.ok) return body.response;
  const core = registerCoreFromRegistrationBlob(body.data.registrationBlob);
  coreLinkManager().dial(core.id);
  return json({ core: withDial(core) }, { status: HTTP_CREATED });
}

/** Forget a Core: hang up first, then drop the registry row, secrets, and cursor. */
export function remove(id: string): Response {
  coreLinkManager().hangup(id);
  if (!removeCore(id)) return notFound("no such Core");
  return noContent();
}
