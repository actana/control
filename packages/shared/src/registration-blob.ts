// Registration blob — the credential a paired client holds, as the blob
// registry keeps it on disk (CONTEXT.md "Registration blob").
//
// **This is a storage format, not an artifact anybody carries.** Until #287 the
// same encoding *was* the hand-carry: `actana setup` printed one base64 line and
// a human moved it — private key included — to the machine that would use it.
// That path is gone, in every direction, and what survives is the narrow thing
// this module was always also doing: `local-core-wiring.ts` writes a machine's
// own Core into `$XDG_CONFIG_HOME/actana/cores/<name>.txt` with
// {@link encodeRegistrationBlob}, on metal from `actana setup` and in a
// container from the daemon's own boot (#288 D9). Nothing prints the result and
// nothing reads it out of a terminal.
//
// The encoding is `base64(JSON({endpoint, label, caCert, clientCert, clientKey,
// bearer}))`. In the Panel, `endpoint` and `label` go to the Core registry and
// the secret fields are sealed; the Panel never logs them or sends them over
// HTTP.
//
// `endpoint` MUST be `wss://` — the mTLS transport (ADR 0002) is mandatory for
// a Core, so {@link decodeRegistrationBlob} refuses anything else rather than
// letting a downgraded entry through.
//
// **`packages/cli` has its own copy and that is deliberate** (`ADR 0025` D3,
// `registration-blob-file.ts`): this package is private and the CLI is
// published, so the client half reads the registry with a decoder it owns. The
// two agree because they both read the wire format, not because either mirrors
// the other's types.
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

/** Encode a registration blob into the single base64 line a registry file holds. */
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
 * Decode a stored registration blob. Returns `null` for any malformed input:
 * bad base64, non-JSON, missing required fields, wrong-typed fields, or an
 * endpoint that is not `wss://` (mTLS is mandatory for a remote Core).
 *
 * Surrounding whitespace (a trailing newline on the file) is tolerated.
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
