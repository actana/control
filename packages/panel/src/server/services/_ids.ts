import { randomBytes } from "node:crypto";

// Domain id generator: `${prefix}-${base36 timestamp}-${6 hex chars}`.
// Same shape was hand-rolled in the sessions/user-terminals services.
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}
