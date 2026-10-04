import { randomHex } from "./random-hex";

/** Client-side id generator matching the server's `${prefix}-${base36 ts}-${6 hex}` shape. */
export function newClientId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomHex(3)}`;
}

const DOMAIN_ID = /^[a-z][a-z0-9]*-[a-z0-9]+-[a-f0-9]{6,}$/i;

export function isClientDomainId(id: string): boolean {
  return DOMAIN_ID.test(id);
}
