import { describe, it, expect } from "vitest";
import { X509Certificate, createPublicKey, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import {
  certFingerprintSha256,
  generateCertMaterial,
  issueServerCert,
  generateClientCsr,
  randomSerial,
  signClientCsr,
} from "../core-cert-material";

// Core generates a self-signed CA + server cert + Panel client cert at
// start (ADR 0002). The Core holds the server cert; the Panel pins the CA
// + client cert (stored in `safeStorage` via the Core registry). The TLS
// handshake is the key-pair handshake; TLS 1.3 is the symmetric encryption.

describe("core cert material", () => {
  it("generates a CA, a server cert, and a client cert as PEM strings", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    expect(mat.ca.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(mat.ca.key).toMatch(/-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----/);
    expect(mat.server.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(mat.server.key).toMatch(/-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----/);
    expect(mat.client.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(mat.client.key).toMatch(/-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----/);
  });

  it("the CA is a CA (basicConstraints CA:TRUE)", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const ca = new X509Certificate(mat.ca.cert);
    expect(ca.ca).toBe(true);
  });

  it("the server cert is signed by the CA", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const caPub = createPublicKey(mat.ca.cert);
    const server = new X509Certificate(mat.server.cert);
    expect(server.verify(caPub)).toBe(true);
    // The server cert must not itself be a CA.
    expect(server.ca).toBe(false);
  });

  it("the client cert is signed by the CA", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const caPub = createPublicKey(mat.ca.cert);
    const client = new X509Certificate(mat.client.cert);
    expect(client.verify(caPub)).toBe(true);
    expect(client.ca).toBe(false);
  });

  it("the server cert's SAN includes the configured host", async () => {
    const mat = await generateCertMaterial({ hosts: ["10.0.0.5"] });
    const server = new X509Certificate(mat.server.cert);
    // subjectAltName is a string like "IP Address:10.0.0.5" or "DNS:localhost".
    expect(server.subjectAltName).toContain("10.0.0.5");
  });

  // ─── Several hosts in one certificate (#347) ─────────────────────────────
  //
  // **These read the subject alternative names back off a minted certificate**,
  // rather than asserting on the list that went in. The input list is what the
  // caller asked for; the SAN extension is what a client's TLS stack will
  // actually check, and the only assertion worth making here is against the
  // second one — a builder that dropped an entry, wrote a DNS name where an IP
  // literal was needed, or forgot the loopback pair would satisfy every
  // assertion made against the input and fail every real dial.

  /**
   * The SAN extension, parsed into the entries a verifier sees.
   *
   * `subjectAltName` renders as `DNS:core, IP Address:10.0.0.5, …`, and the
   * split matters: `toContain` on that string cannot tell a DNS entry from an
   * IP one, and `DNS:10.0.0.5` is the exact mistake that passes a substring
   * check and fails Node's hostname verification.
   */
  const sanEntries = (certPem: string): string[] =>
    (new X509Certificate(certPem).subjectAltName ?? "").split(", ").filter((e) => e.length > 0);

  it("covers every configured host, as DNS or IP as each one requires", async () => {
    const mat = await generateCertMaterial({
      hosts: ["core", "10.0.0.5", "core.example.test"],
    });

    // Read off the certificate, in order, including the loopback pair ADR 0032
    // D9 puts in every one of them.
    expect(sanEntries(mat.server.cert)).toEqual([
      "DNS:core",
      "IP Address:10.0.0.5",
      "DNS:core.example.test",
      "DNS:localhost",
      "IP Address:127.0.0.1",
    ]);
  });

  // The compatibility promise of #347, made against the artefact rather than
  // the argument: a compose file that sets one host must mint the certificate
  // it always minted. The expected list here is exactly what the single-host
  // builder produced before the list existed.
  it("mints the same SANs for a single host as the single-host builder did", async () => {
    expect(sanEntries((await generateCertMaterial({ hosts: ["core"] })).server.cert)).toEqual([
      "DNS:core",
      "DNS:localhost",
      "IP Address:127.0.0.1",
    ]);
    expect(sanEntries((await generateCertMaterial({ hosts: ["10.0.0.5"] })).server.cert)).toEqual([
      "IP Address:10.0.0.5",
      "DNS:localhost",
      "IP Address:127.0.0.1",
    ]);
    // `localhost` was never added twice, and still is not.
    expect(sanEntries((await generateCertMaterial({ hosts: ["localhost"] })).server.cert)).toEqual([
      "DNS:localhost",
      "IP Address:127.0.0.1",
    ]);
  });

  // The primary is the first entry, and it is the name a human reads off the
  // certificate — `openssl x509 -subject`, a browser's viewer, `pair ls`.
  it("names the first host as the common name", async () => {
    const mat = await generateCertMaterial({ hosts: ["core", "10.0.0.5"] });
    expect(new X509Certificate(mat.server.cert).subject).toContain("CN=core");
  });

  it("does not repeat a host the loopback pair already covers", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1", "localhost", "core"] });
    // One entry each. A certificate naming the same address twice verifies
    // identically and reads worse.
    expect(sanEntries(mat.server.cert)).toEqual([
      "IP Address:127.0.0.1",
      "DNS:localhost",
      "DNS:core",
    ]);
  });

  it("re-issuing from the CA covers the new list and drops the old one", async () => {
    const mat = await generateCertMaterial({ hosts: ["core"] });

    const reissued = await issueServerCert({
      ca: { cert: mat.ca.cert, key: mat.ca.key },
      hosts: ["core", "10.0.0.5"],
    });

    expect(sanEntries(reissued.cert)).toEqual([
      "DNS:core",
      "IP Address:10.0.0.5",
      "DNS:localhost",
      "IP Address:127.0.0.1",
    ]);
    // Still the CA a paired client pinned — re-issuing never re-mints (D18).
    expect(new X509Certificate(reissued.cert).verify(createPublicKey(mat.ca.cert))).toBe(true);
  });

  it("defaults the host to localhost when none is given", async () => {
    const mat = await generateCertMaterial();
    const server = new X509Certificate(mat.server.cert);
    expect(server.subjectAltName).toContain("localhost");
  });

  it("produces fresh material on each call (not cached constants)", async () => {
    const a = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const b = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    expect(a.ca.cert).not.toBe(b.ca.cert);
    expect(a.server.key).not.toBe(b.server.key);
    // And a's server cert must NOT verify against b's CA (different roots).
    const bCaPub = createPublicKey(b.ca.cert);
    const aServer = new X509Certificate(a.server.cert);
    expect(aServer.verify(bCaPub)).toBe(false);
  });
});

// ─── CSR signing (#282) ─────────────────────────────────────────────────────
//
// The pairing endpoint's whole cryptographic claim: a certificate signed here
// from a client's own CSR is the same certificate, to the mTLS handshake, as
// the one an operator used to hand-carry — and the private key never came near
// this process.

describe("signing a client CSR against the Core's CA", () => {
  it("issues a client leaf that verifies against the CA and is not itself a CA", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const { csrPem } = await generateClientCsr("laptop");

    const issued = await signClientCsr({
      ca: { cert: mat.ca.cert, key: mat.ca.key },
      csrPem,
      subject: "CN=laptop",
    });

    const cert = new X509Certificate(issued.cert);
    expect(cert.verify(createPublicKey(mat.ca.cert))).toBe(true);
    expect(cert.ca).toBe(false);
    expect(cert.subject).toContain("laptop");
    expect(issued.serial).toBe(cert.serialNumber.toLowerCase());
    expect(issued.notAfter).toBeGreaterThan(Date.now());
  });

  it("writes the same client-leaf extensions the hand-carried client cert has", async () => {
    // The comparison is the assertion: whatever `generateCertMaterial` writes
    // for the Panel's client cert is what a paired client must get, because the
    // handshake on the other end cannot tell them apart and must not have to.
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const { csrPem } = await generateClientCsr("laptop");

    const issued = await signClientCsr({
      ca: { cert: mat.ca.cert, key: mat.ca.key },
      csrPem,
      subject: "CN=laptop",
    });

    const paired = new x509.X509Certificate(issued.cert);
    const handCarried = new x509.X509Certificate(mat.client.cert);
    const extensions = (cert: x509.X509Certificate): unknown =>
      cert.extensions
        .map((ext) => {
          if (ext instanceof x509.BasicConstraintsExtension) return `basicConstraints:cA=${ext.ca}`;
          if (ext instanceof x509.KeyUsagesExtension) return `keyUsage:${ext.usages}`;
          if (ext instanceof x509.ExtendedKeyUsageExtension) return `extKeyUsage:${ext.usages.join(",")}`;
          return null;
        })
        .filter((line) => line !== null)
        .sort();
    expect(extensions(paired)).toEqual(extensions(handCarried));
    expect(extensions(paired)).toContain("basicConstraints:cA=false");
  });

  it("takes only the public key from the CSR — never its subject or its extensions", async () => {
    // A client that has spent a pairing code still does not get to say what its
    // certificate means. This CSR asks to be a CA under another name; the
    // issued certificate is neither.
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const keys = (await webcrypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ["sign", "verify"],
    )) as Parameters<typeof x509.Pkcs10CertificateRequestGenerator.create>[0]["keys"];
    const greedy = await x509.Pkcs10CertificateRequestGenerator.create({
      name: "CN=mission-control-core-ca",
      keys,
      signingAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      extensions: [new x509.BasicConstraintsExtension(true, 5, true)],
    });

    const issued = await signClientCsr({
      ca: { cert: mat.ca.cert, key: mat.ca.key },
      csrPem: greedy.toString("pem"),
      subject: "CN=laptop",
    });

    const cert = new X509Certificate(issued.cert);
    expect(cert.ca).toBe(false);
    expect(cert.subject).toContain("laptop");
    expect(cert.subject).not.toContain("mission-control-core-ca");
    // The key, on the other hand, is exactly the one that asked.
    const requested = new x509.Pkcs10CertificateRequest(greedy.toString("pem"));
    expect(new x509.X509Certificate(issued.cert).publicKey.toString("pem")).toBe(
      requested.publicKey.toString("pem"),
    );
  });

  it("refuses a CSR whose signature does not match the key it carries", async () => {
    // Proof of possession is the only thing the CSR's own signature proves, and
    // it is the reason this Core will not certify a key somebody else holds.
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const { csrPem } = await generateClientCsr("laptop");
    const lines = csrPem.trim().split("\n");
    const body = lines.slice(1, -1).join("");
    const bytes = Buffer.from(body, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    const tampered = `${lines[0]}\n${bytes.toString("base64")}\n${lines[lines.length - 1]}`;

    await expect(
      signClientCsr({ ca: { cert: mat.ca.cert, key: mat.ca.key }, csrPem: tampered, subject: "CN=laptop" }),
    ).rejects.toMatchObject({ name: "CsrRejectedError", rejection: "bad-signature" });
  });

  it("refuses something that is not a CSR at all", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    await expect(
      signClientCsr({ ca: { cert: mat.ca.cert, key: mat.ca.key }, csrPem: "not a CSR", subject: "CN=laptop" }),
    ).rejects.toMatchObject({ name: "CsrRejectedError", rejection: "unparseable" });
  });

  it("refuses an RSA key too small to be worth a signature", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const weakAlg = {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]),
    };
    const keys = (await webcrypto.subtle.generateKey(weakAlg, true, ["sign", "verify"])) as Parameters<
      typeof x509.Pkcs10CertificateRequestGenerator.create
    >[0]["keys"];
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
      name: "CN=weak",
      keys,
      signingAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    });

    await expect(
      signClientCsr({
        ca: { cert: mat.ca.cert, key: mat.ca.key },
        csrPem: csr.toString("pem"),
        subject: "CN=weak",
      }),
    ).rejects.toMatchObject({ name: "CsrRejectedError", rejection: "weak-key" });
  });

  it("gives every issuance its own serial", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const first = await generateClientCsr("laptop");
    const second = await generateClientCsr("desktop");
    const ca = { cert: mat.ca.cert, key: mat.ca.key };

    const a = await signClientCsr({ ca, csrPem: first.csrPem, subject: "CN=laptop" });
    const b = await signClientCsr({ ca, csrPem: second.csrPem, subject: "CN=desktop" });

    expect(a.serial).not.toBe(b.serial);
    // Positive, per RFC 5280 §4.1.2.2 — the top bit of the first byte is clear.
    expect(parseInt(a.serial.slice(0, 2), 16)).toBeLessThan(0x80);
    // And the whole 16 bytes came back. A serial minted with a leading zero
    // byte returns a byte shorter than it went in, because DER writes an
    // INTEGER minimally and the reader strips the pad — see `randomSerial`.
    for (const serial of [a.serial, b.serial]) expect(serial).toMatch(/^[0-9a-f]{32}$/);
  });

  it("never mints a serial the certificate would hand back shortened", () => {
    // The property, drawn often enough to bite. Signing a certificate per draw
    // would take minutes; the issuances above already pin that the serial the
    // certificate reports is the serial `randomSerial` produced, and this pins
    // that every draw is a serial that survives that round trip: 16 bytes, top
    // bit of the first clear so the INTEGER is positive, and the first byte
    // never 0x00 so nothing is stripped off the front of it.
    for (let i = 0; i < 5000; i++) {
      const serial = randomSerial();
      expect(serial).toMatch(/^[0-9a-f]{32}$/);
      const first = parseInt(serial.slice(0, 2), 16);
      expect(first).toBeGreaterThan(0x00);
      expect(first).toBeLessThan(0x80);
    }
  });

  it("mints a client CSR whose private key it hands back and never embeds", async () => {
    const { csrPem, privateKeyPem } = await generateClientCsr("laptop");
    expect(csrPem).toMatch(/-----BEGIN CERTIFICATE REQUEST-----/);
    expect(privateKeyPem).toMatch(/-----BEGIN PRIVATE KEY-----/);
    expect(csrPem).not.toContain("PRIVATE KEY");
  });
});

// ─── The CA fingerprint an operator reads out loud (#283) ───────────────────
//
// `actana pair new` prints this and the client checks the certificate it is
// presented against it before it sends the pairing code (#280 step 3). The
// format is the contract, not a presentation choice: an operator who verifies
// it against `openssl x509 -fingerprint -sha256` must see the same characters,
// or the check they just performed proved nothing.

describe("the CA fingerprint", () => {
  it("is the conventional colon-separated upper-case hex SHA-256", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const fingerprint = certFingerprintSha256(mat.ca.cert);
    expect(fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  });

  it("agrees with what every other tool prints for the same certificate", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    // Node computes this over the DER too. Asserting against it is what keeps
    // the hand-rolled version from quietly hashing the PEM — which would still
    // look like a fingerprint and would match nothing on the client's side.
    expect(certFingerprintSha256(mat.ca.cert)).toBe(new X509Certificate(mat.ca.cert).fingerprint256);
  });

  it("is over the DER, so PEM whitespace cannot move it", async () => {
    const mat = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const rewrapped = mat.ca.cert.replace(/\n/g, "\r\n").trimEnd() + "\n\n";
    expect(certFingerprintSha256(rewrapped)).toBe(certFingerprintSha256(mat.ca.cert));
  });

  it("distinguishes two CAs", async () => {
    const one = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const two = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    expect(certFingerprintSha256(one.ca.cert)).not.toBe(certFingerprintSha256(two.ca.cert));
  });
});
