import { z } from "zod";
import { json, noContent, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { HTTP_CREATED } from "~/shared/http-status";
import { OPERATOR_ID } from "../services/operator";
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  pingWebhook,
} from "../services/webhooks";

/**
 * Webhooks (#574): create, list, delete and ping. Session-only for this PR;
 * no UI. The plaintext signing secret is returned once from create.
 */

const createBody = z.object({
  url: z.string(),
  events: z.array(z.string()).min(1),
  coreIds: z.array(z.string().min(1)).nullable().optional(),
});

const NO_STORE = { "cache-control": "no-store" };

export async function create(request: Request): Promise<Response> {
  const body = await parseJsonBody(request, createBody);
  if (!body.ok) return body.response;
  try {
    const { webhook, secret } = await createWebhook(OPERATOR_ID, body.data);
    return json({ webhook, secret }, { status: HTTP_CREATED, headers: NO_STORE });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}

export async function list(): Promise<Response> {
  return json({ webhooks: await listWebhooks(OPERATOR_ID) }, { headers: NO_STORE });
}

export async function remove(id: string): Promise<Response> {
  try {
    await deleteWebhook(OPERATOR_ID, id);
    return noContent();
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}

export async function ping(id: string): Promise<Response> {
  try {
    return json(await pingWebhook(OPERATOR_ID, id), { headers: NO_STORE });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}

export async function deliveries(id: string): Promise<Response> {
  try {
    return json({ deliveries: await listWebhookDeliveries(OPERATOR_ID, id) }, { headers: NO_STORE });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}
