// The client half of pairing that never leaves the machine: a key pair, and the
// certificate signing request that proves possession of it (#280, #284).
//
// A pairing exchange hands a Core a *public* key and gets a certificate back.
// This module is where the other half stays. Everything here runs before a
// socket is opened, and the only value that ever crosses one is
// {@link ClientCsr.csrPem} — the private key is returned to the caller, put
// into the resulting `CoreRegistrationBlob`, and never given to
// `core-pairing.ts` in a form it could serialise.
//
// **Why a hand-written PKCS#10 encoder rather than a library.** `node:crypto`
// generates key pairs and signs, and it exports a public key as a DER
// `SubjectPublicKeyInfo` — which is the only structure in a CSR that is hard to
// produce. What is left is four fields in a fixed order (RFC 2986 §4), so the
// choice was a ~90-line encoder against a new dependency on the one package in
// this repository whose dependency list is a reviewed artifact
// (`__tests__/package-boundaries.test.ts`, and ADR 0025's "a private one is a
// broken install"). The encoder is checked where it counts: the suite posts
// what it produces at the real Core, whose `assertSignableCsr` parses it with
// `@peculiar/x509` and verifies the signature before signing. A CSR this file
// got wrong fails that test rather than shipping.
//
// **RSA-2048, matching the Core.** `@actana/shared/core-cert-material` refuses
// anything under 2048 bits (`MIN_RSA_MODULUS_BITS`), and its own
// `generateClientCsr` mints exactly this. A client that asked for something
// more exotic would be betting on the CA's parser rather than on the algorithm
// the CA is known to sign.

import { generateKeyPair, sign } from "node:crypto";

/** A client key pair and the request that asks a Core's CA to certify it. */
export type ClientCsr = {
  /** PEM `CERTIFICATE REQUEST`, for the body of a redemption. */
  csrPem: string;
  /**
   * PEM PKCS#8 private key. **Stays on the machine that made it** — it is the
   * `clientKey` of the resulting blob and appears in no request, ever.
   */
  privateKeyPem: string;
};

/** Modulus size. See the header: what the Core's CA is known to sign. */
const RSA_MODULUS_BITS = 2048;

/** Longest common name written into the request. The Core caps its own at 48. */
const MAX_COMMON_NAME = 48;

/** The common name used when a caller offers nothing usable. */
const FALLBACK_COMMON_NAME = "actana-client";

/**
 * Mint a key pair and a CSR naming `commonName`.
 *
 * The subject here is a *request*, and the Core does not honour it: the
 * certificate is issued for the label the operator typed when they opened the
 * pairing session (`core-pairing-routes.ts`, "the subject is the Core's to
 * write"). It is filled in anyway because a CSR with an empty subject is a
 * worse artifact to debug than one that says which machine asked.
 */
export async function generateClientCsr(commonName: string): Promise<ClientCsr> {
  const { publicKey, privateKey } = await new Promise<{
    publicKey: import("node:crypto").KeyObject;
    privateKey: import("node:crypto").KeyObject;
  }>((resolve, reject) => {
    generateKeyPair("rsa", { modulusLength: RSA_MODULUS_BITS }, (err, publicKey, privateKey) => {
      if (err) reject(err);
      else resolve({ publicKey, privateKey });
    });
  });

  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const info = derSequence(
    DER_VERSION_V1,
    derName(certificationRequestName(commonName)),
    spki,
    // `attributes [0] IMPLICIT SET OF Attribute`, empty. Not optional in RFC
    // 2986 — a request with the field left out is one some parsers reject —
    // and nothing this client asks for belongs in it: requested extensions are
    // exactly what the Core refuses to honour.
    DER_EMPTY_ATTRIBUTES,
  );

  // RSASSA-PKCS1-v1_5 over SHA-256, which is what `sign` produces for an RSA
  // key with no `padding` given, and what the algorithm identifier below says.
  const signature = new Uint8Array(sign("sha256", info, privateKey));

  const csr = derSequence(info, DER_SHA256_WITH_RSA, derBitString(signature));

  return {
    csrPem: derToPem("CERTIFICATE REQUEST", csr),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/**
 * A common name as it can appear in a distinguished name.
 *
 * Same conservative set the Core applies to the label it issues for, for the
 * same reason: an X.509 name is structure, `,` and `=` and `+` are part of it,
 * and a CSR is not the place to find out whose escaping is right.
 */
function certificationRequestName(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9 ._-]/g, "-").trim().slice(0, MAX_COMMON_NAME);
  return cleaned.length > 0 ? cleaned : FALLBACK_COMMON_NAME;
}

// ─── A DER writer, as much of one as a CSR needs ───
//
// Tags are written as constants rather than an enum: there are five of them,
// each is used once, and a reader checking this file against RFC 2986 wants the
// byte.

/** `INTEGER 0` — `version` is v1, and v1 is zero. */
const DER_VERSION_V1 = Uint8Array.from([0x02, 0x01, 0x00]);

/** `[0]` constructed, zero-length: the empty attribute set. */
const DER_EMPTY_ATTRIBUTES = Uint8Array.from([0xa0, 0x00]);

/**
 * `AlgorithmIdentifier` for `sha256WithRSAEncryption` — OID
 * 1.2.840.113549.1.1.11, with the explicit `NULL` parameters RFC 4055 §5
 * requires for it. Written out because it is a constant in every request this
 * file produces; an OID encoder would be more code and one more thing to get
 * wrong.
 */
const DER_SHA256_WITH_RSA = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00,
]);

/** OID 2.5.4.3, `id-at-commonName`. */
const DER_OID_COMMON_NAME = Uint8Array.from([0x06, 0x03, 0x55, 0x04, 0x03]);

/** `SEQUENCE` of the given already-encoded members. */
function derSequence(...members: Uint8Array[]): Uint8Array {
  return derTagged(0x30, concat(members));
}

/** `RDNSequence` with the one relative distinguished name `CN=<value>`. */
function derName(commonName: string): Uint8Array {
  const attribute = derSequence(DER_OID_COMMON_NAME, derUtf8String(commonName));
  const rdn = derTagged(0x31, attribute); // SET
  return derSequence(rdn);
}

function derUtf8String(value: string): Uint8Array {
  return derTagged(0x0c, new TextEncoder().encode(value));
}

/**
 * `BIT STRING` holding whole bytes.
 *
 * The leading zero is the count of unused bits in the final byte. A signature
 * is a whole number of bytes, so it is always zero — and it is always present,
 * because a `BIT STRING` without it is a malformed one.
 */
function derBitString(bytes: Uint8Array): Uint8Array {
  return derTagged(0x03, concat([Uint8Array.from([0x00]), bytes]));
}

/** `tag | length | content`, with the length in DER's short or long form. */
function derTagged(tag: number, content: Uint8Array): Uint8Array {
  return concat([Uint8Array.from([tag]), derLength(content.length), content]);
}

/**
 * DER's definite length.
 *
 * Under 128 the length is the byte. At or above it, the first byte is `0x80`
 * plus the number of bytes that follow, big-endian and with no leading zero —
 * the "minimal number of octets" DER insists on, which is why this counts the
 * bytes rather than always writing four.
 */
function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** DER to PEM: base64 in 64-column lines between the two armour lines. */
function derToPem(label: string, der: Uint8Array): string {
  const body = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
