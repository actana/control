// A registration blob, as it is written down.
//
// `actana setup` prints one base64 artifact per machine —
// `base64(JSON({endpoint, label, caCert, clientCert, clientKey, bearer}))`
// (CONTEXT.md "Registration blob"). The SDK takes that decoded, as an object,
// and says so at length in `packages/sdk/src/core-registration-blob.ts`:
// **where a blob is kept and how it is encoded at rest is the CLI's business**
// (#129 D9). This file is that business, and it is deliberately the only place
// in this package that turns bytes into credentials.
//
// Why this decoder is not imported from `@actana/shared`, which has one:
// `packages/shared` is private and stays private ([ADR 0025][adr] D4), and this
// package is the one #129 exists to publish. Importing it would put a private
// package in a published dependency graph — the exact arrangement ADR 0025
// rejected for the SDK, for the same reason. The two decoders agree on the
// wire format because the wire format is what they both read; neither is a
// mirror of a *type* the other owns, which is the duplication ADR 0025 D3
// forbids.
//
// [adr]: ../../../docs/adr/0025-the-protocol-ships-with-the-client.md

import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";

/** A decode that worked, or the one line to print at the operator. */
export type BlobDecodeResult =
  | { ok: true; blob: CoreRegistrationBlob }
  | { ok: false; error: string };

/**
 * Decode the text of a blob file — or of a paste, or of what came in on stdin.
 * Surrounding whitespace is tolerated, because every one of those three arrives
 * with a trailing newline at least some of the time.
 *
 * Every failure is one sentence naming what is wrong with the input. **None of
 * them quotes the input.** A blob is a credential and a malformed one is very
 * often a *nearly* well-formed one — echoing "expected base64, got
 * eyJlbmRwb2ludCI6…" into a terminal, a CI log or a shell history is how the
 * good half of a credential ends up somewhere it cannot be taken back from.
 *
 * `wss://` is required, matching the Panel's decoder and ADR 0002: mTLS is
 * mandatory for a Core, and a `ws://` endpoint in a blob is a downgrade rather
 * than a convenience. (The SDK's `coreConnectionFromBlob` accepts `ws://`
 * because it converts a shape it is handed; this refuses one, because it is the
 * thing being handed a shape.)
 */
export function decodeRegistrationBlobText(raw: string): BlobDecodeResult {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { ok: false, error: "the blob is empty" };

  let json: string;
  try {
    json = Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    return { ok: false, error: "the blob is not base64" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      ok: false,
      error: "the blob does not decode to JSON — check it was pasted whole, with no line breaks introduced",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "the blob decodes to JSON that is not an object" };
  }

  const o = parsed as Record<string, unknown>;
  const missing = (["endpoint", "caCert", "clientCert", "clientKey", "bearer"] as const).filter(
    (field) => typeof o[field] !== "string" || (o[field] as string).length === 0,
  );
  if (missing.length > 0) {
    return { ok: false, error: `the blob is missing ${missing.join(", ")}` };
  }

  const endpoint = o.endpoint as string;
  if (!endpoint.startsWith("wss://")) {
    return {
      ok: false,
      error: "the blob's endpoint is not wss:// — a Core's core link is mTLS (ADR 0002)",
    };
  }

  const label = typeof o.label === "string" ? o.label : "";
  return {
    ok: true,
    blob: {
      endpoint,
      label,
      caCert: o.caCert as string,
      clientCert: o.clientCert as string,
      clientKey: o.clientKey as string,
      bearer: o.bearer as string,
    },
  };
}

/**
 * The parts of a blob that are safe to print, name, sort by and log.
 *
 * This exists so that "never log the blob" is something the code can be *read*
 * to do rather than something every call site has to remember: nothing outside
 * this module hands a whole `CoreRegistrationBlob` to an output function, and
 * the only shape that reaches one is this one. The PEM material and the bearer
 * are not on it, and there is no flag — `--verbose` included — that adds them.
 */
export type BlobSummary = {
  /** The Core's core-link endpoint, `wss://host:port`. Not a secret. */
  endpoint: string;
  /** The machine's own suggested alias, or "" when the blob carried none. */
  label: string;
};

/** Reduce a blob to {@link BlobSummary} — the only shape output ever sees. */
export function summarizeBlob(blob: CoreRegistrationBlob): BlobSummary {
  return { endpoint: blob.endpoint, label: blob.label ?? "" };
}
