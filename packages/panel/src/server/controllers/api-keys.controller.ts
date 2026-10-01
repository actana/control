import { z } from "zod";
import { forbidden, json, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { HTTP_CREATED } from "~/shared/http-status";
import type { ApiPrincipal } from "../api-key-auth";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/api-keys";

/**
 * The owner's API keys: create, list, revoke (#572). Only the Operator's
 * session manages keys. A key can never mint or revoke keys, so these routes
 * are not in `API_KEY_ROUTES`, and each also refuses a key principal itself.
 *
 * The plaintext key is in the response of {@link create} and nowhere else, and
 * that response is marked `no-store`.
 */

const createBody = z.object({
  name: z.string(),
  /** Omitted or null: every Core. Otherwise only these Cores. */
  coreIds: z.array(z.string().min(1)).nullable().optional(),
});

const NO_STORE = { "cache-control": "no-store" };

export async function create(principal: ApiPrincipal, request: Request): Promise<Response> {
  if (principal.kind !== "session") return forbidden("only the Operator manages API keys");
  const body = await parseJsonBody(request, createBody);
  if (!body.ok) return body.response;
  try {
    const { apiKey, key } = await createApiKey(principal.ownerId, body.data);
    return json({ apiKey, key }, { status: HTTP_CREATED, headers: NO_STORE });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}

export async function list(principal: ApiPrincipal): Promise<Response> {
  if (principal.kind !== "session") return forbidden("only the Operator manages API keys");
  return json({ apiKeys: await listApiKeys(principal.ownerId) }, { headers: NO_STORE });
}

export async function revoke(principal: ApiPrincipal, id: string): Promise<Response> {
  if (principal.kind !== "session") return forbidden("only the Operator manages API keys");
  try {
    return json({ apiKey: await revokeApiKey(principal.ownerId, id) }, { headers: NO_STORE });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}
