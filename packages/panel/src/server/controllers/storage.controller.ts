import { z } from "zod";
import { json, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import { getStorageConfig, saveStorageConfig } from "../services/storage";
import { sharedFolders } from "../services/shared-folders";

/**
 * The Shared-folder storage config (#564, #566). `GET` answers with whether a master key is set and when
 * it was rotated, never with the key. `PUT` is the write-only route that sets or rotates it. `POST …/test`
 * reuses the pairing isolation probe. There is no route that returns, exports or proxies a key, and no
 * public credentials route: a Core's 1-hour key goes over the core-link and nowhere else.
 */

const putBody = z.object({
  backend: z.string(),
  endpoint: z.string(),
  bucket: z.string(),
  prefix: z.string(),
  region: z.string().optional(),
  oidcIssuer: z.string().optional(),
  oidcAudience: z.string().optional(),
  keyId: z.string().optional(),
  roleArn: z.string().optional(),
  accountId: z.string().optional(),
  parentAccessKeyId: z.string().optional(),
  anonKey: z.string().optional(),
  uploadSizeLimitBytes: z.number().optional(),
  masterKey: z.string().optional(),
});

const testBody = z.object({
  /** Optional Core to probe as; when absent the Panel uses a throwaway probe id. */
  coreId: z.string().optional(),
});

export async function read(): Promise<Response> {
  const storage = await getStorageConfig();
  const cores = await sharedFolders().listStorageCores();
  return json({ storage, cores });
}

export async function write(request: Request): Promise<Response> {
  const body = await parseJsonBody(request, putBody);
  if (!body.ok) return body.response;
  try {
    const { view, rotated } = await saveStorageConfig(body.data);
    if (rotated) await sharedFolders().reissueAll();
    return json({ storage: view });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}

/** Issue a 1-hour key and prove it cannot reach another Core's folder (same probe as pairing). */
export async function test(request: Request): Promise<Response> {
  const body = await parseJsonBody(request, testBody);
  if (!body.ok) return body.response;
  try {
    const result = await sharedFolders().testConfiguredConnection(body.data.coreId);
    return json({ result });
  } catch (err) {
    return rethrowUnlessDomain(err);
  }
}
