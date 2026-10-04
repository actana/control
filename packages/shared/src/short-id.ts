import { randomHex } from "./random-hex";

/**
 * Opaque unique id: `${prefix}-${base36 time}-${10 hex of CSPRNG}`.
 * Ids are treated as opaque strings — nothing parses the segments after the prefix.
 */
export function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomHex(5)}`;
}
