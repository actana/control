// Registration blob — the single base64 artifact emitted by `core install`
// and pasted once into the Panel's "Add Core" (ADR 0003, CONTEXT.md
// "Registration blob").
//
// The blob is `base64(JSON({endpoint, label, caCert, clientCert, clientKey,
// bearer}))`. `endpoint` and `label` go to the Core registry; the secret
// fields go to `safeStorage` (macOS keychain / OS equivalent). The Panel never
// logs or sends the secret fields over HTTP.
//
// `endpoint` MUST be `wss://` — the mTLS transport (ADR 0002) is mandatory for
// a Core. A Core that is somehow reached without one never
// goes through this blob path.
//
// This file is self-contained (no `~/` imports) so it compiles under both the
// Vite (browser/server) and the Core's CommonJS tsconfigs. It uses Node's
// `Buffer` for base64, available in all three runtimes (the renderer preload
// runs in a Node-powered context with `Buffer` exposed).

/** The decoded shape of a registration blob. */
export type RegistrationBlob = {
  /** `wss://<host>:<port>` — the Core's core-link endpoint. */
  endpoint: string;
  /** Human-friendly alias for the Core (optional in the blob; "" if absent). */
  label?: string;
  /** PEM-encoded self-signed CA cert that signed the Core server cert. */
  caCert: string;
  /** PEM-encoded client cert presented to the Core in the mTLS handshake. */
  clientCert: string;
  /** PEM-encoded private key for {@link RegistrationBlob.clientCert}. */
  clientKey: string;
  /** Signed bearer `{coreId, exp, sig}` presented in the `auth` frame. */
  bearer: string;
};

/** Encode a registration blob into a single base64 paste string. */
export function encodeRegistrationBlob(blob: RegistrationBlob): string {
  const json = JSON.stringify({
    endpoint: blob.endpoint,
    label: blob.label ?? "",
    caCert: blob.caCert,
    clientCert: blob.clientCert,
    clientKey: blob.clientKey,
    bearer: blob.bearer,
  });
  return Buffer.from(json, "utf8").toString("base64");
}

/**
 * Decode a pasted registration blob. Returns `null` for any malformed input:
 * bad base64, non-JSON, missing required fields, wrong-typed fields, or an
 * endpoint that is not `wss://` (mTLS is mandatory for a remote Core).
 *
 * Surrounding whitespace (a trailing newline from a paste) is tolerated.
 */
export function decodeRegistrationBlob(raw: string): RegistrationBlob | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let json: string;
  try {
    json = Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const endpoint = o.endpoint;
  const label = o.label;
  const caCert = o.caCert;
  const clientCert = o.clientCert;
  const clientKey = o.clientKey;
  const bearer = o.bearer;
  if (
    typeof endpoint !== "string" ||
    typeof caCert !== "string" ||
    typeof clientCert !== "string" ||
    typeof clientKey !== "string" ||
    typeof bearer !== "string"
  ) {
    return null;
  }
  // mTLS is mandatory for a remote Core (ADR 0002). A `ws://` endpoint in a
  // blob is a downgrade attack or a misconfigured install — reject it.
  if (!endpoint.startsWith("wss://")) return null;
  const labelStr = typeof label === "string" ? label : "";
  return {
    endpoint,
    label: labelStr,
    caCert,
    clientCert,
    clientKey,
    bearer,
  };
}
