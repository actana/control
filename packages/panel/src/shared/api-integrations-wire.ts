/**
 * Wire types for Settings › API & integrations (screen 09; #572 / #573 / #574).
 * The Panel's browser and the session routes share these shapes; plaintext keys
 * and webhook secrets are never in a list response — only in the create reply.
 */

import type { ApiKeyPermission } from "./api-key-permissions";
import type { WebhookEventType } from "./webhooks";

/** What an API key is as the owner sees it. No hash and no plaintext. */
export type ApiKeyView = {
  id: string;
  name: string;
  prefix: string;
  allCores: boolean;
  coreIds: string[];
  /** What the key may do (#688), in canonical order; never empty. */
  permissions: ApiKeyPermission[];
  createdAt: number;
  revokedAt: number | null;
  /** When the key expires, or null for a key that lives until it is revoked (#689). */
  expiresAt: number | null;
};

/** A webhook as the owner sees it, plus the newest delivery when one exists. */
export type WebhookView = {
  id: string;
  url: string;
  events: WebhookEventType[];
  allCores: boolean;
  coreIds: string[];
  createdAt: number;
  updatedAt: number;
  lastDelivery: WebhookDeliveryView | null;
};

export type WebhookDeliveryView = {
  id: string;
  webhookId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: number;
  deliveredAt: number | null;
  /** When the next retry is due, for a pending failed attempt; null otherwise. */
  nextAttemptAt: number | null;
};

/** Placeholder in copyable commands — never a real key. */
export const API_KEY_PLACEHOLDER = "ak_…";

export function mcpAddCommand(panelOrigin: string): string {
  const origin = panelOrigin.replace(/\/$/, "");
  return `claude mcp add --transport http actana ${origin}/mcp --header "Authorization: Bearer ${API_KEY_PLACEHOLDER}"`;
}

export function restApiBaseLine(panelOrigin: string): string {
  const origin = panelOrigin.replace(/\/$/, "");
  return `${origin}/api/v1 · Authorization: Bearer ${API_KEY_PLACEHOLDER}`;
}
