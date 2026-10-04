/**
 * `bytes` random bytes as lowercase hex, from the platform's CSPRNG.
 *
 * `getRandomValues` rather than `randomUUID`: it exists in every secure and
 * insecure context a Panel is served from (a plain-http origin behind a reverse
 * proxy has no `randomUUID`), so there is no `Math.random` fallback to reach for.
 * Ids built from it name Sessions, and a Session id is not something to guess.
 */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
