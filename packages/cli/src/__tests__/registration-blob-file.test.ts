// The decoder, on its own — the only module in this package that turns bytes
// into credentials (#129 D9).
//
// Everything else covers it through a verb, which proves the verbs and leaves
// the decoder's own contract implicit. Its contract has two halves and they
// pull in opposite directions: **say precisely what is wrong**, and **never
// quote the input**. A blob is a credential, and a malformed one is very often
// a nearly well-formed one, so the second half is the one under pressure every
// time somebody improves an error message.

import { describe, it, expect } from "vitest";
import {
  decodeRegistrationBlobText,
  encodeRegistrationBlobText,
  summarizeBlob,
} from "../registration-blob-file.ts";
import { SENTINELS, sentinelBlobText } from "./cli-harness.ts";

/** The blob shape, as an object, before it is encoded. */
function blobObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpoint: "wss://core.test:9444",
    label: "the-test-core",
    caCert: "ca",
    clientCert: "cert",
    clientKey: "key",
    bearer: "bearer",
    ...overrides,
  };
}

function encode(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString(
    "base64",
  );
}

describe("what a blob has to be", () => {
  it("decodes the real thing", () => {
    const result = decodeRegistrationBlobText(sentinelBlobText());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blob.endpoint).toBe("wss://core.test:9444");
      expect(summarizeBlob(result.blob)).toEqual({
        endpoint: "wss://core.test:9444",
        label: "the-test-core",
      });
    }
  });

  it("tolerates the whitespace every one of its three sources adds", () => {
    // A file with a trailing newline, a paste, and a pipe. All three arrive
    // padded at least some of the time.
    expect(decodeRegistrationBlobText(`\n  ${sentinelBlobText()}  \n`).ok).toBe(true);
  });

  it("decodes a blob a terminal or a mail client line-wrapped", () => {
    // This has always worked, because Node's base64 decoder skips characters
    // outside the alphabet — including newlines. The alphabet check added for
    // the review of #201 strips whitespace before testing precisely so that it
    // corrects a diagnosis without narrowing what is accepted.
    const wrapped = sentinelBlobText().replace(/(.{40})/g, "$1\n");
    expect(wrapped).toContain("\n");
    expect(decodeRegistrationBlobText(wrapped).ok).toBe(true);
  });
});

describe("what it says when a blob is wrong", () => {
  it("says `not base64` for input that is not base64", () => {
    // The message that could never print before. `Buffer.from(x, "base64")`
    // does not throw on junk — it skips every character outside the alphabet
    // and decodes the remainder — so the `catch` this replaced was unreachable,
    // and input that was not base64 at all landed on the JSON message below.
    // That sent the reader hunting for a line break in something that was never
    // a blob in the first place.
    for (const junk of ["not-a-blob!!", "hello world!", "@@@@", "ey!!!==="]) {
      const result = decodeRegistrationBlobText(junk);
      expect(result.ok, junk).toBe(false);
      if (!result.ok) expect(result.error, junk).toBe("the blob is not base64");
    }
  });

  it("tells base64url from base64 rather than decoding it into nonsense", () => {
    // `-` and `_` are the base64url alphabet. Skipped rather than rejected,
    // they used to silently corrupt the decode and surface as a JSON error
    // about a blob that was pasted whole.
    const result = decodeRegistrationBlobText("eyJlbmRwb2lu-dCI6_Q");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("the blob is not base64");
  });

  it("keeps the JSON message for base64 that is not JSON", () => {
    // The control on the test above: the two messages have to stay distinct,
    // or fixing the first one just moved the confusion. This *is* base64, and
    // what it decodes to is the problem.
    const result = decodeRegistrationBlobText(encode("this is not json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not decode to JSON");
  });

  it("names the fields a blob is missing", () => {
    const result = decodeRegistrationBlobText(encode({ endpoint: "wss://core.test:9444" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("caCert, clientCert, clientKey, bearer");
  });

  it("refuses a ws:// endpoint — a Core's link is mTLS (ADR 0002)", () => {
    const result = decodeRegistrationBlobText(encode(blobObject({ endpoint: "ws://core.test:9444" })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ADR 0002");
  });

  it("rejects an empty blob before anything else", () => {
    const result = decodeRegistrationBlobText("   \n  ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("the blob is empty");
  });

  it("never quotes what it was handed, on any failure path", () => {
    // The property the whole module exists to hold, asserted where the
    // messages are written rather than only where they are printed. Each of
    // these is a *nearly* well-formed blob carrying real sentinel credentials,
    // which is exactly the input an error message is most tempted to echo.
    const nearly = [
      // Right shape, wrong scheme — the failure that has a valid blob behind it.
      encode(blobObject({ endpoint: "ws://core.test:9444", caCert: SENTINELS[0] })),
      // Right shape, one field short.
      encode({ endpoint: "wss://core.test:9444", bearer: SENTINELS[3] }),
      // Truncated: base64 of a real blob, cut in half.
      sentinelBlobText().slice(0, 120),
      // Not base64 at all, but with a credential sitting in it.
      `${SENTINELS[3]} !!`,
    ];

    for (const input of nearly) {
      const result = decodeRegistrationBlobText(input);
      if (result.ok) continue;
      for (const secret of SENTINELS) {
        expect(result.error, `error quoted a credential for input ${input.slice(0, 12)}…`).not.toContain(
          secret,
        );
      }
      // Not just the secrets: nothing of the input at all. A 24-character run
      // of it appearing in the message would mean the same leak with the
      // sentinel renamed.
      expect(result.error).not.toContain(input.slice(0, 24));
    }
  });
});

describe("encodeRegistrationBlobText", () => {
  // The other direction, which #285 needs: `actana core pair` is handed a blob
  // *object* by the SDK and the registry stores text. What matters is that the
  // two halves of this module are each other's inverse — a credential that
  // encoded but did not decode would land on disk as an entry `core ls` reports
  // as corrupt, on a machine that has just been told pairing worked.
  it("round-trips a blob through the decoder", () => {
    const blob = {
      endpoint: "wss://core.test:9444",
      caCert: "ca",
      clientCert: "cert",
      clientKey: "key",
      bearer: "bearer",
    };
    const result = decodeRegistrationBlobText(encodeRegistrationBlobText(blob));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blob).toEqual({ ...blob, label: "" });
  });

  it("keeps a label when there is one, and writes no key for one there is not", () => {
    const withLabel = encodeRegistrationBlobText({
      endpoint: "wss://core.test:9444",
      label: "the-test-core",
      caCert: "ca",
      clientCert: "cert",
      clientKey: "key",
      bearer: "bearer",
    });
    expect(summarizeBlob(unwrap(withLabel)).label).toBe("the-test-core");

    // A paired credential has no alias, because the Core's redemption answer
    // has no field for one. An empty string written here would put a blank
    // LABEL column in `core ls` on the strength of a field nobody set.
    const without = encodeRegistrationBlobText({
      endpoint: "wss://core.test:9444",
      caCert: "ca",
      clientCert: "cert",
      clientKey: "key",
      bearer: "bearer",
    });
    expect(JSON.parse(Buffer.from(without, "base64").toString("utf8"))).not.toHaveProperty("label");
  });
});

/** Decode text this suite just encoded, failing loudly if it will not. */
function unwrap(text: string) {
  const result = decodeRegistrationBlobText(text);
  if (!result.ok) throw new Error(`the encoder wrote something the decoder refuses: ${result.error}`);
  return result.blob;
}
