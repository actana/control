import { z } from "zod";
import { json, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { getStorageConfig, saveStorageConfig } from "../services/storage";

/**
 * The Shared-folder storage config (#564). `GET` answers with whether a master key is set, never with the key.
 * `PUT` is the write-only route that sets or rotates it. There is no route that returns, exports or proxies a key,
 * and no public credentials route: a Core's 1-hour key goes over the core-link and nowhere else.
 */

const putBody = z.object({
  backend: z.string(),
  endpoint: z.string(),
  bucket: z.string(),
  prefix: z.string(),
  region: z.string().optional(),
  oidcIssuer: z.string(),
  oidcAudience: z.string().optional(),
  keyId: z.string(),
  masterKey: z.string().optional(),
});

export async function read(): Promise<Response> {
  return json({ storage: await getStorageConfig() });
}

export async function write(request: Request): Promise<Response> {
  const body = await parseJsonBody(request, putBody);
  if (!body.ok) return body.response;
  try {
    return json({ storage: await saveStorageConfig(body.data) });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}
