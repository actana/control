// The Panel's one sender for a Core's file routes, over mTLS (#129 F11, ADR 0030).
//
// The Panel's own Files route for a Project (`/api/cores/:id/projects/:id/files`) is retired
// (#580 T-404); what stays here is the credentialed `fetch` the Shared-folder task dispatch uses
// to reach a Core's `/v1/files` (`task-dispatch/shared-factory.ts`).
import { createCoreFilesFetch, type CoreFilesFetch } from "@actana/sdk/core";

/**
 * One sender per Core, kept for the life of the process.
 *
 * `createCoreFilesFetch` builds an undici `Agent` on first use and an `Agent`
 * *is* a connection pool. One per request would mean a fresh TLS handshake for
 * every request the Shared-folder dispatch makes, and would leave the pools behind to be
 * collected — which is a slow leak rather than an error, and therefore the kind
 * that survives review.
 *
 * Keyed by the credentials as well as the Core id: re-pairing a Core writes new
 * material under the same id, and a cached sender presenting the retired
 * certificate would be refused at the handshake with an error naming no cause.
 */
const sendersByCore = new Map<string, { fingerprint: string; fetch: CoreFilesFetch }>();

export function filesFetchFor(
  coreId: string,
  secrets: { caCert: string; clientCert: string; clientKey: string },
  makeFetch: typeof createCoreFilesFetch,
): CoreFilesFetch {
  // The client certificate identifies the pairing and the CA pins the server;
  // both change together on a re-pair, and neither is a secret this Panel does
  // not already hold. The key is deliberately not part of the fingerprint — it
  // never travels alone.
  const fingerprint = `${secrets.caCert.length}:${secrets.clientCert}`;
  const cached = sendersByCore.get(coreId);
  if (cached && cached.fingerprint === fingerprint) return cached.fetch;
  const fetch = makeFetch({ ca: secrets.caCert, cert: secrets.clientCert, key: secrets.clientKey });
  sendersByCore.set(coreId, { fingerprint, fetch });
  return fetch;
}
