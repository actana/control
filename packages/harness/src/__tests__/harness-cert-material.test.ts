import { describe, it, expect } from "vitest";
import { X509Certificate, createPublicKey } from "node:crypto";
import { generateCertMaterial } from "../harness-cert-material";

// Harness generates a self-signed CA + server cert + Panel client cert at
// start (ADR 0002). The Harness holds the server cert; the Panel pins the CA
// + client cert (stored in `safeStorage` via the Core registry). The TLS
// handshake is the key-pair handshake; TLS 1.3 is the symmetric encryption.

describe("harness cert material", () => {
  it("generates a CA, a server cert, and a client cert as PEM strings", async () => {
    const mat = await generateCertMaterial({ host: "127.0.0.1" });
    expect(mat.ca.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(mat.ca.key).toMatch(/-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----/);
    expect(mat.server.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(mat.server.key).toMatch(/-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----/);
    expect(mat.client.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(mat.client.key).toMatch(/-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----/);
  });

  it("the CA is a CA (basicConstraints CA:TRUE)", async () => {
    const mat = await generateCertMaterial({ host: "127.0.0.1" });
    const ca = new X509Certificate(mat.ca.cert);
    expect(ca.ca).toBe(true);
  });

  it("the server cert is signed by the CA", async () => {
    const mat = await generateCertMaterial({ host: "127.0.0.1" });
    const caPub = createPublicKey(mat.ca.cert);
    const server = new X509Certificate(mat.server.cert);
    expect(server.verify(caPub)).toBe(true);
    // The server cert must not itself be a CA.
    expect(server.ca).toBe(false);
  });

  it("the client cert is signed by the CA", async () => {
    const mat = await generateCertMaterial({ host: "127.0.0.1" });
    const caPub = createPublicKey(mat.ca.cert);
    const client = new X509Certificate(mat.client.cert);
    expect(client.verify(caPub)).toBe(true);
    expect(client.ca).toBe(false);
  });

  it("the server cert's SAN includes the configured host", async () => {
    const mat = await generateCertMaterial({ host: "10.0.0.5" });
    const server = new X509Certificate(mat.server.cert);
    // subjectAltName is a string like "IP Address:10.0.0.5" or "DNS:localhost".
    expect(server.subjectAltName).toContain("10.0.0.5");
  });

  it("defaults the host to localhost when none is given", async () => {
    const mat = await generateCertMaterial();
    const server = new X509Certificate(mat.server.cert);
    expect(server.subjectAltName).toContain("localhost");
  });

  it("produces fresh material on each call (not cached constants)", async () => {
    const a = await generateCertMaterial({ host: "127.0.0.1" });
    const b = await generateCertMaterial({ host: "127.0.0.1" });
    expect(a.ca.cert).not.toBe(b.ca.cert);
    expect(a.server.key).not.toBe(b.server.key);
    // And a's server cert must NOT verify against b's CA (different roots).
    const bCaPub = createPublicKey(b.ca.cert);
    const aServer = new X509Certificate(a.server.cert);
    expect(aServer.verify(bCaPub)).toBe(false);
  });
});
