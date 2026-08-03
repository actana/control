// Harness cert material — generates a self-signed CA + server cert + Panel
// client cert at Harness start (ADR 0002, CONTEXT.md "Registration blob").
//
// The Harness holds the server cert (presented in the TLS handshake); the
// Panel pins the CA + client cert (stored in `safeStorage` via the Core
// registry). Both server and client certs are signed by the CA. The TLS
// handshake is mutual (`requestCert: true, rejectUnauthorized: true`), so a
// Panel without the pinned client cert never gets past the handshake.
//
// Uses the `selfsigned` package (pure-JS X.509 over Node WebCrypto) so the
// Harness can generate material at start without shelling out to `openssl`.
// `selfsigned` v5 is async-only, so {@link generateCertMaterial} is a Promise.
//
// Harness process only — never imported by the browser.

import selfsigned from "selfsigned";

export type CertPem = {
  /** PEM-encoded certificate. */
  cert: string;
  /** PEM-encoded private key (unencrypted — the Harness reads it at boot). */
  key: string;
};

export type CertMaterial = {
  /** Self-signed CA that signs the server + client certs. Pinned by the Panel. */
  ca: CertPem;
  /** Server cert presented by the Harness in the mTLS handshake. */
  server: CertPem;
  /** Client cert presented by the Panel in the mTLS handshake. */
  client: CertPem;
};

export type GenerateCertMaterialOptions = {
  /**
   * The host the server cert is valid for (SAN). Defaults to `localhost` +
   * `127.0.0.1`. For a remote Harness this is the VM's reachable address
   * (e.g. `10.0.0.5`); the Panel dials that host, so the SAN must match or
   * TLS hostname verification fails.
   */
  host?: string;
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
 * Harness generates once at start; reissuing is a separate VM-side flow
 * (ADR 0003 "Reissue").
 */
export async function generateCertMaterial(
  opts: GenerateCertMaterialOptions = {},
): Promise<CertMaterial> {
  const host = opts.host && opts.host.length > 0 ? opts.host : "localhost";
  const caDays = opts.days ?? CA_DAYS;
  const leafDays = opts.days ?? LEAF_DAYS;
  const notBefore = new Date();

  // ─── CA (self-signed) ───
  const ca = await selfsigned.generate(
    [
      { name: "commonName", value: "mission-control-harness-ca" },
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
  // type 2 = DNS, type 7 = IPv4. If the host parses as an IP, add it as IP;
  // otherwise add it as DNS. Always also cover localhost + 127.0.0.1 so a
  // loopback dial against the same Harness works too.
  const sanAltNames: { type: 2 | 7; value?: string; ip?: string }[] = [];
  if (isIp(host)) {
    sanAltNames.push({ type: 7, ip: host });
  } else {
    sanAltNames.push({ type: 2, value: host });
  }
  if (host !== "localhost") sanAltNames.push({ type: 2, value: "localhost" });
  sanAltNames.push({ type: 7, ip: "127.0.0.1" });

  const server = await selfsigned.generate(
    [{ name: "commonName", value: host }],
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
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: sanAltNames },
      ],
    },
  );

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
    server: { cert: server.cert, key: server.private },
    client: { cert: client.cert, key: client.private },
  };
}

/** Crude IPv4 detector — good enough for SAN choice (no false positives that matter). */
function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}
