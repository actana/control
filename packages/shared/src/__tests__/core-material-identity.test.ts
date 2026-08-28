// Whether a material file is an identity *this* Core can serve (#348).
//
// The failure this exists to prevent is not a corrupt file — it is a perfectly
// well-formed one from a previous generation of the product. Pre-rename
// material has the same filename, the same eight fields and the same types as
// current material; the only thing that tells them apart is the CA at the top,
// and until this check nothing looked. The daemon loaded it, presented it, and
// the operator's first news was `wrong version number` from a client: a
// message about a wire protocol, for a problem about an identity.

import { describe, it, expect, beforeAll } from "vitest";
import selfsigned from "selfsigned";
import {
  checkMaterialIdentity,
  mintFreshMaterial,
  CORE_CA_COMMON_NAME,
  LEGACY_CA_COMMON_NAME,
  type PersistedMaterial,
} from "../core-material-store";
import { issueServerCert } from "../core-cert-material";

let current: PersistedMaterial;
/** A second, unrelated identity — a valid Core's, but not this one's. */
let other: PersistedMaterial;

beforeAll(async () => {
  current = await mintFreshMaterial(["core.example.test"]);
  other = await mintFreshMaterial(["core.example.test"]);
}, 60_000);

/** A CA named as the Harness-era installer named it, and material chained to it. */
async function preRenameMaterial(): Promise<PersistedMaterial> {
  const notBefore = new Date();
  const ca = await selfsigned.generate(
    [
      { name: "commonName", value: LEGACY_CA_COMMON_NAME },
      { name: "organizationName", value: "Mission Control" },
    ],
    {
      algorithm: "sha256",
      notBeforeDate: notBefore,
      notAfterDate: new Date(notBefore.getTime() + 86_400_000),
      extensions: [
        { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    },
  );
  const server = await issueServerCert({
    ca: { cert: ca.cert, key: ca.private },
    hosts: ["core.example.test"],
  });
  return {
    ...current,
    caCert: ca.cert,
    caKey: ca.private,
    serverCert: server.cert,
    serverKey: server.key,
  };
}

describe("material this Core can serve", () => {
  it("passes what this Core mints", () => {
    expect(checkMaterialIdentity(current)).toBeNull();
    expect(CORE_CA_COMMON_NAME).toBe("mission-control-core-ca");
  });
});

describe("material from before the rename", () => {
  it("is refused, and named for what it is rather than as a parse error", async () => {
    const legacy = await preRenameMaterial();
    const refusal = checkMaterialIdentity(legacy)!;

    expect(refusal).not.toBeNull();
    expect(refusal).toContain(LEGACY_CA_COMMON_NAME);
    expect(refusal).toMatch(/rename/i);
    // The operator's next move, in the message rather than in a doc.
    expect(refusal).toContain("actana setup");
  });

  it("is otherwise indistinguishable from current material, which is the point", async () => {
    const legacy = await preRenameMaterial();
    // Same fields, same types, same file — everything `readMaterialFile`
    // looked at before this check existed.
    expect(Object.keys(legacy).sort()).toEqual(Object.keys(current).sort());
    for (const key of ["caCert", "serverCert", "serverKey"] as const) {
      expect(typeof legacy[key]).toBe("string");
      expect(legacy[key]).toContain("-----BEGIN");
    }
  });
});

describe("material that does not hang together", () => {
  it("refuses a CA no version of this product minted", async () => {
    const stranger = await selfsigned.generate([{ name: "commonName", value: "some-other-ca" }], {
      algorithm: "sha256",
    });
    const refusal = checkMaterialIdentity({ ...current, caCert: stranger.cert })!;
    expect(refusal).toContain("some-other-ca");
    expect(refusal).toMatch(/no version of this product has minted/);
  });

  it("refuses a server certificate the CA beside it did not issue", () => {
    // Two real identities, each valid on its own — the mix is what no client
    // can validate, and it is what a half-finished manual repair produces.
    const refusal = checkMaterialIdentity({
      ...current,
      serverCert: other.serverCert,
      serverKey: other.serverKey,
    })!;
    expect(refusal).toMatch(/not issued by the CA beside it/);
  });

  it("refuses a certificate and key that are not a pair", () => {
    const refusal = checkMaterialIdentity({ ...current, serverKey: other.serverKey })!;
    expect(refusal).toMatch(/are not a pair/);
    // Said here rather than left to the handshake, which says nothing.
    expect(refusal).toMatch(/handshake/);
  });

  it("refuses bytes that are not certificates at all", () => {
    expect(checkMaterialIdentity({ ...current, caCert: "not a certificate" })).toMatch(
      /`caCert` is not a certificate/,
    );
    expect(checkMaterialIdentity({ ...current, serverCert: "-----BEGIN CERTIFICATE-----\nx\n" }))
      .toMatch(/`serverCert` is not a certificate/);
    expect(checkMaterialIdentity({ ...current, serverKey: "not a key" })).toMatch(
      /`serverKey` is not a private key/,
    );
  });

  it("says what to run, whatever the reason", () => {
    for (const broken of [
      { ...current, caCert: "junk" },
      { ...current, serverCert: "junk" },
      { ...current, serverKey: "junk" },
      { ...current, serverCert: other.serverCert, serverKey: other.serverKey },
    ]) {
      expect(checkMaterialIdentity(broken)).toContain("actana setup");
    }
  });
});
