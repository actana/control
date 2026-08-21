// A registration blob, as it is written down.
//
// The registry keeps one credential per named Core, as
// `base64(JSON({endpoint, label, caCert, clientCert, clientKey, bearer}))`
// in a 0600 file (CONTEXT.md "Registration blob"). The SDK takes that decoded,
// as an object, and says so at length in
// `packages/sdk/src/core-registration-blob.ts`: **where a blob is kept and how
// it is encoded at rest is the CLI's business** (#129 D9). This file is that
// business, and it is deliberately the only place in this package that turns
// bytes into credentials.
//
// **This is a storage format and not an artifact, which is a distinction #287
// made real.** The same encoding used to be both: `actana setup` printed one
// base64 line, a human carried it, and `actana core add` read it back here.
// That path is gone in both directions. What is left is `actana core pair`
// writing what a Core signed for it, and every verb below reading it back.
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
 * Decode the text of a registry file, or of `ACTANA_CORE_BLOB`. Surrounding
 * whitespace is tolerated, because both arrive with a trailing newline at least
 * some of the time.
 *
 * Every failure is one sentence naming what is wrong with the input. **None of
 * them quotes the input.** A stored credential that will not decode is very
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

  // Base64 is checked, not caught. `Buffer.from(x, "base64")` does not throw on
  // input that is not base64 — it *skips* every character outside the alphabet
  // and decodes what is left — so the `try`/`catch` this replaces had an
  // unreachable arm, and "the blob is not base64" was a sentence that could
  // never print. Input that was not base64 at all fell through to the JSON
  // message instead, which sent the reader looking for a line break in
  // something that was never a blob.
  //
  // Interior whitespace is stripped before the check rather than rejected: the
  // skipping behaviour meant a blob line-wrapped by a terminal, a mail client
  // or a copy out of a web page has always decoded, and this is a correction to
  // a diagnosis, not a narrowing of what is accepted.
  const compact = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return { ok: false, error: "the blob is not base64" };
  }
  const json = Buffer.from(compact, "base64").toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      ok: false,
      error: "the stored credential does not decode to JSON — the file may be truncated",
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
 * Write a blob down, in exactly the form {@link decodeRegistrationBlobText}
 * reads back.
 *
 * The other direction of the same one file, and it is how a credential gets
 * into the registry at all: `actana core pair` gets a `CoreRegistrationBlob`
 * object back from the SDK, and the registry stores text. Encoding it anywhere
 * else would be a second opinion about the format at rest — the thing this
 * module's header says it is the only place for — and the round trip is
 * asserted rather than assumed (`registration-blob-file.test.ts`).
 *
 * **`label` is written only when there is one.** A paired credential carries no
 * alias at all, because the Core's redemption answer has no field for one
 * (#284). An empty string here would put a blank LABEL column in `actana core
 * ls` on the strength of a field nobody set, so the key is left out instead and
 * the decoder's `?? ""` answers for it.
 *
 * The result is base64 of compact JSON and has no trailing newline. The decoder
 * trims either way, which matters because a registry file restored from a
 * backup or copied by hand often gains one.
 */
export function encodeRegistrationBlobText(blob: CoreRegistrationBlob): string {
  const label = blob.label ?? "";
  return Buffer.from(
    JSON.stringify({
      endpoint: blob.endpoint,
      ...(label === "" ? {} : { label }),
      caCert: blob.caCert,
      clientCert: blob.clientCert,
      clientKey: blob.clientKey,
      bearer: blob.bearer,
    }),
    "utf8",
  ).toString("base64");
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
