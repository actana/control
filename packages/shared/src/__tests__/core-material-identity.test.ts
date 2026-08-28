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
  it("is reported as foreign, not as unusable — it works, and the rename is not its fault", async () => {
    // The correction the review asked for. The Harness-era CA serves TLS
    // exactly as it always did; what broke on the machine in #348 was the
    // environment-variable rename, which `core-boot-refusals.ts` stops on its
    // own. Refusing this material would cost every paired client its pairing
    // to fix a problem it does not have.
    const legacy = await preRenameMaterial();
    const issue = checkMaterialIdentity(legacy)!;

    expect(issue.severity).toBe("foreign");
    expect(issue.message).toContain(LEGACY_CA_COMMON_NAME);
    expect(issue.message).toMatch(/rename/i);
    expect(issue.message).toMatch(/kept and served/);
  });

  it("is refused once it genuinely cannot serve, and then it is not called old", async () => {
    // Provenance is checked last on purpose: pre-rename material with a
    // mismatched key is broken, and "an install from before the rename" would
    // send the operator after the wrong thing.
    const legacy = await preRenameMaterial();
    const issue = checkMaterialIdentity({ ...legacy, serverKey: current.serverKey })!;

    expect(issue.severity).toBe("unusable");
    expect(issue.message).not.toContain(LEGACY_CA_COMMON_NAME);
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
  it("refuses a CA that did not sign the leaf beside it, whatever it is called", async () => {
    // A stranger's CA cannot have signed our server certificate, so this is
    // caught as unusable before provenance is ever considered.
    const stranger = await selfsigned.generate([{ name: "commonName", value: "some-other-ca" }], {
      algorithm: "sha256",
    });
    const issue = checkMaterialIdentity({ ...current, caCert: stranger.cert })!;
    expect(issue.severity).toBe("unusable");
    expect(issue.message).toMatch(/not issued by the CA beside it/);
  });

  it("refuses a server certificate the CA beside it did not issue", () => {
    // Two real identities, each valid on its own — the mix is what no client
    // can validate, and it is what a half-finished manual repair produces.
    const issue = checkMaterialIdentity({
      ...current,
      serverCert: other.serverCert,
      serverKey: other.serverKey,
    })!;
    expect(issue.severity).toBe("unusable");
    expect(issue.message).toMatch(/not issued by the CA beside it/);
  });

  it("refuses a certificate and key that are not a pair", () => {
    const issue = checkMaterialIdentity({ ...current, serverKey: other.serverKey })!;
    expect(issue.severity).toBe("unusable");
    expect(issue.message).toMatch(/are not a pair/);
    // Said here rather than left to the handshake, which says nothing.
    expect(issue.message).toMatch(/handshake/);
  });

  it("refuses bytes that are not certificates at all", () => {
    const message = (material: PersistedMaterial) => checkMaterialIdentity(material)?.message ?? "";
    expect(message({ ...current, caCert: "not a certificate" })).toMatch(
      /`caCert` is not a certificate/,
    );
    expect(message({ ...current, serverCert: "-----BEGIN CERTIFICATE-----\nx\n" })).toMatch(
      /`serverCert` is not a certificate/,
    );
    expect(message({ ...current, serverKey: "not a key" })).toMatch(
      /`serverKey` is not a private key/,
    );
  });

  it("says what to run, whatever the reason — and it is a command that works", () => {
    // `actana setup` is named because `resolveMaterial` re-mints on exactly
    // this severity. `actana-setup.test.ts` is where that is proved end to end;
    // what this pins is that no unusable message points somewhere else.
    for (const broken of [
      { ...current, caCert: "junk" },
      { ...current, serverCert: "junk" },
      { ...current, serverKey: "junk" },
      { ...current, serverCert: other.serverCert, serverKey: other.serverKey },
    ]) {
      const issue = checkMaterialIdentity(broken)!;
      expect(issue.severity).toBe("unusable");
      expect(issue.message).toContain("actana setup");
    }
  });
});
