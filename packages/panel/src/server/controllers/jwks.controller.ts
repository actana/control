import { json } from "../http-responses";
import { storageJwks } from "../services/storage";

/** Where SeaweedFS fetches the Panel's token-signing key set from (`SEAWEEDFS_OIDC_JWKS_URL`, #566). */
export const JWKS_PATH = "/.well-known/jwks.json";

/**
 * The public JWKS of the key the storage service signs Core tokens with. No session: SeaweedFS has none, and the
 * document is public material by construction (`storageJwks` never returns the key). The cache header is for proxies
 * and browsers: SeaweedFS does not read it. It keeps the key set for about an hour (`jwksCacheTTLSeconds`) and
 * refetches only when a token carries a `kid` it does not know, so a rotation under a new Key id is picked up at once
 * and one under the same Key id is not seen for up to an hour. An empty set is cached for less, so a first key is
 * picked up quickly.
 */
export async function read(): Promise<Response> {
  const jwks = await storageJwks();
  const maxAge = jwks.keys.length > 0 ? 300 : 15;
  return json(jwks, { headers: { "cache-control": `public, max-age=${maxAge}` } });
}
