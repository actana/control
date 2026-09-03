// Core cert material — generates a self-signed CA + server cert + Panel
// client cert at Core start (ADR 0002, CONTEXT.md "Registration blob").
//
// The Core holds the server cert (presented in the TLS handshake); the
// Panel pins the CA + client cert (stored in `safeStorage` via the Core
// registry). Both server and client certs are signed by the CA. The TLS
// handshake is mutual (`requestCert: true, rejectUnauthorized: true`), so a
// Panel without the pinned client cert never gets past the handshake.
//
// Uses the `selfsigned` package (pure-JS X.509 over Node WebCrypto) so the
// Core can generate material at start without shelling out to `openssl`.
// `selfsigned` v5 is async-only, so {@link generateCertMaterial} is a Promise.
//
// Core process only — never imported by the browser.

import selfsigned from "selfsigned";
import * as x509 from "@peculiar/x509";
import { createHash, randomBytes, webcrypto } from "node:crypto";

export type CertPem = {
  /** PEM-encoded certificate. */
  cert: string;
  /** PEM-encoded private key (unencrypted — the Core reads it at boot). */
  key: string;
};

/** A signing CA — the pair {@link issueServerCert} signs against. */
export type CertAuthority = {
  /** PEM-encoded CA certificate. */
  cert: string;
  /** PEM-encoded CA private key. */
  key: string;
};

export type CertMaterial = {
  /** Self-signed CA that signs the server + client certs. Pinned by the Panel. */
  ca: CertPem;
  /** Server cert presented by the Core in the mTLS handshake. */
  server: CertPem;
  /** Client cert presented by the Panel in the mTLS handshake. */
  client: CertPem;
};

export type GenerateCertMaterialOptions = {
  /**
   * The hosts the server cert is valid for (SANs). Defaults to `localhost` +
   * `127.0.0.1`. For a remote Core these are the addresses a client reaches it
   * on (e.g. `["core", "10.0.0.5"]`); a client dials one of them, so it must be
   * in the SAN list or TLS hostname verification fails.
   *
   * A list rather than one host since #347: one Core is often reachable two
   * ways at once — a compose service name on the internal network and a LAN
   * address from the host machine — and covering only one of them meant
   * changing the answer, which re-signs the certificate and unpairs everything
   * still dialling the old name. **The first entry is the primary**: it is the
   * common name, and it is the endpoint a pairing hands back by default.
   */
  hosts?: readonly string[];
  /** Cert validity in days. Defaults to 10 years for the CA, 1 year for leaves. */
  days?: number;
};

const CA_DAYS = 10 * 365;
const LEAF_DAYS = 365;

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Generate a fresh self-signed CA + server cert + client cert. Each call
 * produces new keys (see the "fresh material on each call" test) — the
 * Core generates once at start; reissuing is a separate VM-side flow
 * (ADR 0003 "Reissue").
 */
export async function generateCertMaterial(
  opts: GenerateCertMaterialOptions = {},
): Promise<CertMaterial> {
  const hosts = certHosts(opts.hosts);
  const caDays = opts.days ?? CA_DAYS;
  const leafDays = opts.days ?? LEAF_DAYS;
  const notBefore = new Date();

  // ─── CA (self-signed) ───
  const ca = await selfsigned.generate(
    [
      { name: "commonName", value: "mission-control-core-ca" },
      { name: "organizationName", value: "Mission Control" },
    ],
    {
      algorithm: "sha256",
      notBeforeDate: notBefore,
      notAfterDate: addDays(notBefore, caDays),
      extensions: [
        { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
        {
          name: "keyUsage",
          keyCertSign: true,
          cRLSign: true,
          digitalSignature: true,
          critical: true,
        },
      ],
    },
  );

  // ─── Server cert, signed by the CA ───
  const server = await issueServerCert({
    ca: { cert: ca.cert, key: ca.private },
    hosts,
    days: leafDays,
    notBefore,
  });

  // ─── Client cert (Panel), signed by the CA ───
  const client = await selfsigned.generate(
    [{ name: "commonName", value: "mission-control-panel" }],
    {
      algorithm: "sha256",
      notBeforeDate: notBefore,
      notAfterDate: addDays(notBefore, leafDays),
      ca: { key: ca.private, cert: ca.cert },
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        { name: "extKeyUsage", clientAuth: true },
      ],
    },
  );

  return {
    ca: { cert: ca.cert, key: ca.private },
    server,
    client: { cert: client.cert, key: client.private },
  };
}

export type IssueServerCertOptions = {
  /** The CA to sign with — the Panel has already pinned its certificate. */
  ca: CertAuthority;
  /**
   * The hosts a client dials, every one of which the SAN list must cover. The
   * first is the primary — the common name, and the default endpoint (#347).
   */
  hosts: readonly string[];
  /** Leaf validity in days. Defaults to a year. */
  days?: number;
  /** Backdate/align the validity window. Defaults to now. */
  notBefore?: Date;
};

/**
 * Sign a server cert for `hosts` against an existing CA.
 *
 * Split out of {@link generateCertMaterial} because a Core that moves keeps its
 * identity and only outgrows its SAN: re-issuing from the CA the Panel already
 * pinned leaves that Panel's trust intact, where a fresh CA would revoke it
 * (ADR 0016 D18).
 */
export async function issueServerCert(opts: IssueServerCertOptions): Promise<CertPem> {
  const hosts = certHosts(opts.hosts);
  const notBefore = opts.notBefore ?? new Date();

  const server = await selfsigned.generate(
    [{ name: "commonName", value: hosts[0]! }],
    {
      algorithm: "sha256",
      notBeforeDate: notBefore,
      notAfterDate: addDays(notBefore, opts.days ?? LEAF_DAYS),
      ca: { key: opts.ca.key, cert: opts.ca.cert },
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: serverSanAltNames(hosts) },
      ],
    },
  );
  return { cert: server.cert, key: server.private };
}

/**
 * The hosts a certificate is signed for, with the one default this module has
 * always had.
 *
 * `localhost` for an absent or empty list, exactly as a missing `host` meant
 * before #347 — every caller that passed nothing got a loopback certificate and
 * still does.
 */
function certHosts(hosts: readonly string[] | undefined): string[] {
  const named = (hosts ?? []).map((host) => host.trim()).filter((host) => host.length > 0);
  return named.length > 0 ? named : ["localhost"];
}

/**
 * The SAN list for a server certificate: every configured host, then the two
 * loopback names.
 *
 * type 2 = DNS, type 7 = IPv4. A host that parses as an IP is added as an IP
 * and anything else as DNS, because a client verifying `10.0.0.5` against a
 * `DNS:10.0.0.5` entry fails — Node checks IP literals against `iPAddress`
 * entries and nothing else.
 *
 * `localhost` and `127.0.0.1` are appended to every server certificate, on the
 * mint path and the re-issue path both, so the machine's own CLI can dial the
 * Core it is standing on (ADR 0032 D9, `core-self-register.ts`). #347 did not
 * change that: an operator's list is *added to* the loopback pair rather than
 * replacing it.
 *
 * Repeats are dropped. An operator who lists `127.0.0.1` explicitly, or lists
 * the same name twice, gets one entry for it — a certificate naming the same
 * address twice verifies identically and reads worse.
 */
function serverSanAltNames(hosts: readonly string[]): { type: 2 | 7; value?: string; ip?: string }[] {
  const altNames: { type: 2 | 7; value?: string; ip?: string }[] = [];
  const seen = new Set<string>();
  const add = (host: string): void => {
    if (host.length === 0 || seen.has(host)) return;
    seen.add(host);
    altNames.push(isIp(host) ? { type: 7, ip: host } : { type: 2, value: host });
  };
  for (const host of hosts) add(host);
  add("localhost");
  add("127.0.0.1");
  return altNames;
}

/** Crude IPv4 detector — good enough for SAN choice (no false positives that matter). */
function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

// ─── CSR signing (#282) ─────────────────────────────────────────────────────
//
// Everything above generates a key pair *and* a certificate for it, because
// everything above signs for a party the Core is standing in for. Pairing is
// the case where it is not: the client's key is born on the client and never
// crosses the wire in either direction (#280), so what arrives here is a
// certificate signing request and the only thing the Core adds is its
// signature.
//
// `selfsigned` cannot do this — its one export mints keys. So this half talks
// to `@peculiar/x509` directly, which is the library `selfsigned` itself is
// built on: the same ASN.1 encoder and the same Node WebCrypto backend already
// in the dependency tree, reached one layer lower rather than pulled in beside
// it.

// The WebCrypto types, taken from `@peculiar/x509`'s own signatures rather than
// from an ambient global.
//
// `Crypto`, `CryptoKey` and `CryptoKeyPair` are ambient names, and which ones
// exist — and what they mean — depends on the `lib` of whichever tsconfig is
// compiling this file. Three do: the Core's (Node types, no `CryptoKeyPair`),
// the Panel's (DOM types, where `CryptoKey` is a *different* type from
// `node:crypto`'s), and `packages/shared`'s own. Naming the library's parameter
// types instead is the one spelling that compiles under all three, and the
// casts below are the boundary between Node's WebCrypto and the library's view
// of it — a boundary that exists only in the type system, since `selfsigned`
// hands the same objects to the same library at runtime.
type X509Crypto = NonNullable<Parameters<typeof x509.cryptoProvider.set>[1]>;
type X509SigningKey = x509.X509CertificateCreateWithKeyParams["signingKey"];
type X509KeyPair = x509.Pkcs10CertificateRequestCreateParams["keys"];

// `@peculiar/x509` resolves its crypto through a module-global provider, and
// `selfsigned` sets the same one at import. Setting it here too is not
// redundant: this module is imported by paths that never touch `selfsigned`
// (the pairing endpoint signs a CSR without generating anything), and a
// provider that happens to be set by whoever was imported first is not a
// dependency, it is a coincidence.
x509.cryptoProvider.set(webcrypto as unknown as X509Crypto);

/**
 * RSA-2048 with SHA-256 — what {@link generateCertMaterial} already issues, and
 * therefore what a CA key loaded from `material.json` is.
 *
 * The algorithm is named at import rather than read off the key because
 * WebCrypto's `importKey` demands it up front: PKCS#8 says the key is RSA, not
 * what it may be used for or with which digest.
 */
const CA_SIGNING_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** Client key pairs this module mints for its own callers. See {@link generateClientCsr}. */
const CLIENT_KEY_ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
} as const;

/**
 * Smallest RSA modulus this CA will sign.
 *
 * A pairing code buys one certificate, and a client that asks for a 512-bit key
 * gets a certificate this Core's own CA vouches for. Refusing here costs a
 * legitimate client nothing — every client in this repository mints 2048 — and
 * denies an attacker who has spent a code the option of a key they can factor
 * afterwards.
 */
const MIN_RSA_MODULUS_BITS = 2048;

/** How long an issued client certificate is good for. A year, as every leaf here is. */
const CLIENT_LEAF_DAYS = LEAF_DAYS;

/** Why a CSR was refused. The endpoint maps every one of these to one refusal. */
export type CsrRejection =
  | "unparseable"
  | "bad-signature"
  | "weak-key"
  | "unsupported-key";

/** A CSR the Core would not sign, with the reason for the audit log. */
export class CsrRejectedError extends Error {
  constructor(readonly rejection: CsrRejection, message: string) {
    super(message);
    this.name = "CsrRejectedError";
  }
}

export type SignClientCsrOptions = {
  /** The CA to sign against — `PersistedMaterial`'s `caCert` + `caKey`. */
  ca: CertAuthority;
  /** The PEM `CERTIFICATE REQUEST` the client posted. */
  csrPem: string;
  /**
   * The subject to issue for, as a distinguished name (`CN=laptop`).
   *
   * The Core's to decide, not the CSR's. A certificate signing request carries
   * a subject and a set of requested extensions, and honouring either would let
   * a client that has spent a pairing code choose what its certificate *says* —
   * up to and including `cA: true`, which would turn one paired laptop into a
   * second certificate authority this Core trusts. So the subject is passed in
   * by the caller from what the operator typed, the extensions below are fixed,
   * and the only thing taken from the request is the public key it is proving
   * possession of.
   */
  subject: string;
  /** Leaf validity in days. Defaults to a year. */
  days?: number;
  /** Backdate/align the validity window. Defaults to now. */
  notBefore?: Date;
};

/** An issued client certificate, and the two fields that identify it later. */
export type SignedClientCert = {
  /** PEM-encoded client certificate. No key: there is no key here to hand back. */
  cert: string;
  /** Hex serial, unique per issuance — what `actana pair revoke` names (#283). */
  serial: string;
  /** The subject as issued. */
  subject: string;
  /** Wall-clock ms after which the certificate stops verifying. */
  notAfter: number;
};

/**
 * Sign a client CSR against the Core's own CA, with the client-leaf extensions.
 *
 * The extensions are exactly the ones {@link generateCertMaterial} writes for
 * the Panel's client cert — `basicConstraints cA:false`, `keyUsage
 * digitalSignature + keyEncipherment`, `extKeyUsage clientAuth` — because the
 * certificate this returns has to be indistinguishable, to the mTLS handshake
 * on `pty-core-link-server.ts`, from the one an operator hand-carried in a
 * registration blob. A paired client is a client, not a second kind of client.
 *
 * The CSR's own signature is verified first, and that check is not a formality:
 * it is the only proof that whoever posted the request holds the private key
 * for the public key inside it. Without it, an attacker who spent a pairing
 * code could submit somebody else's public key and have this CA issue a
 * certificate for a key they do not hold — useless to them, but a certificate
 * naming a machine that never asked for one.
 *
 * Throws {@link CsrRejectedError} for anything wrong with the request. Callers
 * on the pre-auth surface must not pass the reason back to the client — it is
 * for the audit log.
 */
export async function signClientCsr(opts: SignClientCsrOptions): Promise<SignedClientCert> {
  const csr = await readSignableCsr(opts.csrPem);

  const notBefore = opts.notBefore ?? new Date();
  const notAfter = addDays(notBefore, opts.days ?? CLIENT_LEAF_DAYS);
  const caCert = new x509.X509Certificate(opts.ca.cert);
  const caKey = await importCaKey(opts.ca.key);

  const issued = await x509.X509CertificateGenerator.create({
    // 16 random bytes, forced positive: a serial is the certificate's name in
    // every later revocation list and `pair ls` row, and two clients sharing
    // one would make a revocation ambiguous.
    serialNumber: randomSerial(),
    subject: opts.subject,
    issuer: caCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: CA_SIGNING_ALGORITHM,
    publicKey: csr.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
    ],
  });

  return {
    cert: issued.toString("pem"),
    serial: issued.serialNumber,
    subject: issued.subject,
    notAfter: notAfter.getTime(),
  };
}

/**
 * Read a CSR this CA would sign, or throw {@link CsrRejectedError}.
 *
 * Exported because the pairing endpoint has to know whether a request is
 * signable **before** it consumes the pairing session: consuming is what stops
 * two redemptions both winning, so it happens last, and a client whose CSR was
 * malformed should not have spent the operator's session to find that out.
 * {@link signClientCsr} calls this too, so the two paths cannot drift on what
 * "acceptable" means.
 */
export async function assertSignableCsr(csrPem: string): Promise<void> {
  await readSignableCsr(csrPem);
}

/** Parse, prove possession, and check the key is worth a signature. */
async function readSignableCsr(csrPem: string): Promise<x509.Pkcs10CertificateRequest> {
  let csr: x509.Pkcs10CertificateRequest;
  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch (err) {
    throw new CsrRejectedError("unparseable", `the CSR could not be read: ${errorText(err)}`);
  }

  let selfSigned: boolean;
  try {
    selfSigned = await csr.verify();
  } catch (err) {
    throw new CsrRejectedError("bad-signature", `the CSR signature could not be checked: ${errorText(err)}`);
  }
  if (!selfSigned) {
    throw new CsrRejectedError("bad-signature", "the CSR is not signed by the key it carries");
  }

  assertKeyStrongEnough(csr.publicKey);
  return csr;
}

/** A client key pair and the CSR that proves possession of it. */
export type ClientCsr = {
  /** PEM `CERTIFICATE REQUEST` to post to a Core's pairing endpoint. */
  csrPem: string;
  /** PEM PKCS#8 private key. **Stays on the machine that made it.** */
  privateKeyPem: string;
};

/**
 * Mint a client key pair and a CSR for it — the client half of pairing.
 *
 * Lives beside the signer because the two are one contract and a mismatch
 * between them is the failure neither side can diagnose alone: this is what the
 * Core's own tests post at {@link signClientCsr}, so the request shape the CA
 * accepts is exercised by the code that produces it rather than asserted twice.
 *
 * The published SDK will declare its own (ADR 0025 D1 — the protocol ships with
 * the client, and `@actana/shared` is private). That is not duplication of a
 * wire type: a CSR *is* a wire-standard format, and what would be duplicated is
 * a call to WebCrypto.
 */
export async function generateClientCsr(commonName: string): Promise<ClientCsr> {
  const keys = (await webcrypto.subtle.generateKey(CLIENT_KEY_ALGORITHM, true, [
    "sign",
    "verify",
  ])) as unknown as X509KeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${commonName}`,
    keys,
    signingAlgorithm: CLIENT_KEY_ALGORITHM,
  });
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return {
    csrPem: csr.toString("pem"),
    privateKeyPem: derToPem("PRIVATE KEY", Buffer.from(pkcs8)),
  };
}

/**
 * Refuse a key too small to be worth a signature.
 *
 * Only RSA is checked for size because only RSA has a size that can be wrong in
 * this way; an EC key's curve is its strength and every curve WebCrypto will
 * parse here is stronger than 2048-bit RSA. A key algorithm this build cannot
 * reason about at all is refused rather than waved through — an unknown is not
 * a pass.
 */
function assertKeyStrongEnough(publicKey: x509.PublicKey): void {
  const algorithm = publicKey.algorithm as { name?: string; modulusLength?: number };
  const name = String(algorithm.name ?? "");
  if (name.startsWith("RSA")) {
    const bits = algorithm.modulusLength ?? 0;
    if (bits < MIN_RSA_MODULUS_BITS) {
      throw new CsrRejectedError(
        "weak-key",
        `the CSR carries a ${bits}-bit RSA key; this Core signs ${MIN_RSA_MODULUS_BITS} and up`,
      );
    }
    return;
  }
  if (name === "ECDSA" || name === "Ed25519") return;
  throw new CsrRejectedError("unsupported-key", `this Core does not sign ${name || "unnamed"} keys`);
}

/** Import a PEM PKCS#8 CA key as a WebCrypto signing key. */
async function importCaKey(pem: string): Promise<X509SigningKey> {
  try {
    return (await webcrypto.subtle.importKey("pkcs8", pemToDer(pem), CA_SIGNING_ALGORITHM, false, [
      "sign",
    ])) as unknown as X509SigningKey;
  } catch (err) {
    // Not a `CsrRejectedError`: nothing is wrong with the *request*. The Core's
    // own CA key is unreadable, which is an operator-visible failure of this
    // Core and not something the client did.
    throw new Error(`this Core's CA key could not be read for signing: ${errorText(err)}`);
  }
}

/**
 * A positive 16-byte serial, hex-encoded — RFC 5280 §4.1.2.2 wants positive.
 *
 * The leading byte is forced into 0x01..0x7f, and the floor matters as much as
 * the ceiling. The top bit clear is what makes the DER INTEGER positive. The
 * non-zero is what keeps the serial we minted and the serial the certificate
 * reports back the same string: DER writes an INTEGER minimally, and
 * `@peculiar/x509` hands `serialNumber` back with a leading zero byte stripped,
 * so a serial that began 0x00 came back a byte shorter — and reading as
 * negative-looking hex if the byte behind it had its own top bit set. That is a
 * 1-in-256 draw, and the serial is the certificate's name in every later
 * revocation list and `pair ls` row, so it has to be the same name on both
 * sides of the issuance every time.
 *
 * Exported for the tests, which draw it many times: a single issuance only
 * meets the bad byte once in 256, which is too rare for a test to rely on and
 * exactly often enough to redden someone else's pull request.
 */
export function randomSerial(): string {
  const bytes = randomBytes(16);
  const first = bytes[0]! & 0x7f;
  bytes[0] = first === 0 ? 0x01 : first;
  return bytes.toString("hex");
}

/**
 * PEM to DER, as a `Uint8Array` backed by its own `ArrayBuffer`.
 *
 * Not a `Buffer`: WebCrypto's `BufferSource` will not take one, because a
 * `Buffer` may be a view onto a pooled — possibly shared — allocation.
 */
function pemToDer(pem: string) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const decoded = Buffer.from(body, "base64");
  const der = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  der.set(decoded);
  return der;
}

function derToPem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── The CA fingerprint an operator reads out loud ──────────────────────────
//
// `actana pair new` prints this beside the pairing code, and the client's
// bootstrap dial checks the CA it was presented against it before it sends the
// code (#280 step 3, #283, #284). It is the whole of what makes that first
// dial verifiable: the client has no certificate yet, so there is nothing else
// on the wire it can pin.

/**
 * SHA-256 over a certificate's DER, rendered colon-separated upper-case hex.
 *
 * **The format is the contract**, not a presentation choice. A human compares
 * these two by eye — one on the Core's terminal, one on the client's — so it is
 * the conventional form every other tool prints (`openssl x509 -fingerprint
 * -sha256`, a browser's certificate viewer, `X509Certificate.fingerprint256`),
 * grouped into byte-sized pairs an eye can chunk. An operator who checks it
 * against `openssl` must see the same string, character for character, or the
 * check they just performed proved nothing.
 *
 * Over the **DER**, not the PEM: the PEM is base64 of exactly these bytes
 * wrapped in a header, a footer and line breaks, and hashing that would make
 * the fingerprint depend on line width and trailing whitespace. The DER is the
 * certificate; everything else is packaging.
 *
 * Computed here rather than read off `node:crypto`'s `X509Certificate` so that
 * the format lives in code with a test rather than in a property whose spelling
 * this repository does not own — `core-cert-material.test.ts` asserts the two
 * agree, which is the check that keeps the convention honest.
 */
export function certFingerprintSha256(certPem: string): string {
  const digest = createHash("sha256").update(pemToDer(certPem)).digest("hex").toUpperCase();
  return (digest.match(/.{2}/g) ?? []).join(":");
}
