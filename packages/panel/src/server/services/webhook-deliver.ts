import * as dns from "node:dns/promises";
import * as https from "node:https";
import type { IncomingMessage, RequestOptions } from "node:http";
import { isIP } from "node:net";
import { URL } from "node:url";
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "~/shared/webhooks";
import { signWebhookBody } from "./webhook-signing";
import { isBlockedWebhookAddress } from "./webhook-ssrf";

/**
 * HTTPS POST of a signed webhook delivery (#574): resolve the host, refuse
 * blocked addresses, pin the connection to the checked IP with the original
 * host for TLS SNI and the Host header, and never follow redirects.
 */

export type WebhookSendResult =
  | { kind: "sent"; statusCode: number }
  | { kind: "refused"; error: string }
  | { kind: "failed"; statusCode: number | null; error: string };

export type WebhookLookup = (hostname: string) => Promise<string[]>;

/** Compatible with `https.request` so tests can spy on the pinned options. */
export type WebhookHttpsRequest = (
  options: RequestOptions,
  callback?: (res: IncomingMessage) => void,
) => ReturnType<typeof https.request>;

const defaultLookup: WebhookLookup = async (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return [host];
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

export async function sendSignedWebhook(
  input: {
    url: string;
    secret: string;
    deliveryId: string;
    timestamp: string;
    body: string;
  },
  opts: {
    lookup?: WebhookLookup;
    timeoutMs?: number;
    /**
     * After SSRF checks the looked-up addresses, connect here instead of the
     * pinned IP. Tests only: a local TLS server cannot bind a public address.
     */
    connectTo?: string;
    /** Override `https.request` so a test can assert the pin without a socket. */
    request?: WebhookHttpsRequest;
  } = {},
): Promise<WebhookSendResult> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { kind: "refused", error: "invalid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { kind: "refused", error: "https only" };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) return { kind: "refused", error: "invalid URL" };

  let addresses: string[];
  try {
    addresses = await (opts.lookup ?? defaultLookup)(hostname);
  } catch (err) {
    return { kind: "failed", statusCode: null, error: err instanceof Error ? err.message : String(err) };
  }
  if (addresses.length === 0) return { kind: "refused", error: "no addresses" };

  const pinned = addresses.find((a) => !isBlockedWebhookAddress(a));
  if (!pinned) {
    return { kind: "refused", error: `refused address: ${addresses.join(", ")}` };
  }
  const connectHost = opts.connectTo ?? pinned;

  const signature = signWebhookBody(input.secret, input.timestamp, input.body);
  const port = parsed.port ? Number(parsed.port) : 443;
  const path = `${parsed.pathname}${parsed.search}`;
  const hostHeader = parsed.port ? `${hostname}:${parsed.port}` : hostname;
  const request = opts.request ?? https.request;

  return new Promise((resolve) => {
    const req = request(
      {
        host: connectHost,
        servername: hostname,
        port,
        path,
        method: "POST",
        headers: {
          Host: hostHeader,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(input.body, "utf8"),
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_TIMESTAMP_HEADER]: input.timestamp,
          [WEBHOOK_DELIVERY_HEADER]: input.deliveryId,
        },
        // Never follow redirects: https.request does not, and we refuse 3xx below.
        maxHeaderSize: 16_384,
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve({ kind: "sent", statusCode: status });
          return;
        }
        if (status >= 300 && status < 400) {
          resolve({ kind: "failed", statusCode: status, error: "redirect not followed" });
          return;
        }
        resolve({ kind: "failed", statusCode: status, error: `HTTP ${status}` });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => {
      resolve({ kind: "failed", statusCode: null, error: err.message });
    });
    req.write(input.body, "utf8");
    req.end();
  });
}
