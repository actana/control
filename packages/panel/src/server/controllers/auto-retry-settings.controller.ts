import { z } from "zod";
import { forbidden, json, parseJsonBody, rethrowUnlessDomain } from "./_helpers";
import type { ApiPrincipal } from "../api-key-auth";
import { getAutoRetrySettings, listPausedCores, resumeAutoRetryOnCore, setAutoRetrySettings } from "../services/auto-retry-settings";
import { findCoreById } from "../repositories/cores.repo";

/**
 * The instance settings of auto-retry (#958): the kill switch, the attempts ceiling and the Cores whose circuit breaker
 * tripped, which the Operator resumes. Only the Operator's session reaches them; an API key never does.
 */

const patchBody = z.strictObject({ enabled: z.boolean().optional(), maxAttemptsCeiling: z.number().int().min(1).max(3).optional() });

async function payload(ownerId: number) {
  const pausedCores = await Promise.all(
    (await listPausedCores(ownerId)).map(async (coreId) => ({ coreId, label: (await findCoreById(ownerId, coreId))?.label ?? coreId })),
  );
  return { ...(await getAutoRetrySettings(ownerId)), pausedCores };
}

function requireSession(principal: ApiPrincipal): Response | null {
  return principal.kind === "session" ? null : forbidden("only the Operator changes the auto-retry settings");
}

export async function read(principal: ApiPrincipal): Promise<Response> {
  const denied = requireSession(principal);
  if (denied) return denied;
  return json(await payload(principal.ownerId));
}

export async function update(principal: ApiPrincipal, request: Request): Promise<Response> {
  const denied = requireSession(principal);
  if (denied) return denied;
  const body = await parseJsonBody(request, patchBody);
  if (!body.ok) return body.response;
  try {
    await setAutoRetrySettings(principal.ownerId, body.data);
    return json(await payload(principal.ownerId));
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}

/** Resume auto-retry on a Core whose breaker tripped. A Core that is not paused is left as it is. */
export async function resumeCore(principal: ApiPrincipal, coreId: string): Promise<Response> {
  const denied = requireSession(principal);
  if (denied) return denied;
  try {
    await resumeAutoRetryOnCore(principal.ownerId, coreId);
    return json(await payload(principal.ownerId));
  } catch (e) {
    return rethrowUnlessDomain(e);
  }
}
