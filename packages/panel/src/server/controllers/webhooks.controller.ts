import { z } from "zod";
import { forbidden, json, noContent, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { HTTP_CREATED } from "~/shared/http-status";
import type { ApiPrincipal } from "../api-key-auth";
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  pingWebhook,
} from "../services/webhooks";

/**
 * Webhooks (#574): create, list, delete and ping for Settings › API &
 * integrations (screen 09). Only the Operator's session manages them. The list
 * includes each hook's newest delivery so the page can show last delivery
 * without a second round-trip. The plaintext signing secret is returned once
 * from create.
 */

const createBody = z.object({
  url: z.string(),
  events: z.array(z.string()).min(1),
  coreIds: z.array(z.string().min(1)).nullable().optional(),
});

const NO_STORE = { "cache-control": "no-store" };

function requireSession(principal: ApiPrincipal): Response | null {
  if (principal.kind !== "session") return forbidden("only the Operator manages webhooks");
  return null;
}

export async function create(principal: ApiPrincipal, request: Request): Promise<Response> {
  const denied = requireSession(principal);
  if (denied) return denied;
  const body = await parseJsonBody(request, createBody);
  if (!body.ok) return body.response;
  try {
    const { webhook, secret } = await createWebhook(principal.ownerId, body.data);
    return json({ webhook, secret }, { status: HTTP_CREATED, headers: NO_STORE });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}

export async function list(principal: ApiPrincipal): Promise<Response> {
  const denied = requireSession(principal);
  if (denied) return denied;
  return json({ webhooks: await listWebhooks(principal.ownerId) }, { headers: NO_STORE });
}

export async function remove(principal: ApiPrincipal, id: string): Promise<Response> {
  const denied = requireSession(principal);
  if (denied) return denied;
  try {
    await deleteWebhook(principal.ownerId, id);
    return noContent();
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}

export async function ping(principal: ApiPrincipal, id: string): Promise<Response> {
  const denied = requireSession(principal);
  if (denied) return denied;
  try {
    return json(await pingWebhook(principal.ownerId, id), { headers: NO_STORE });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}

export async function deliveries(principal: ApiPrincipal, id: string): Promise<Response> {
  const denied = requireSession(principal);
  if (denied) return denied;
  try {
    return json({ deliveries: await listWebhookDeliveries(principal.ownerId, id) }, { headers: NO_STORE });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}
