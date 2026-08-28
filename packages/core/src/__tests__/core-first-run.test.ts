import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { X509Certificate, createPublicKey } from "node:crypto";
import { loadOrMintMaterial } from "../core-first-run";
import selfsigned from "selfsigned";
import { issueServerCert } from "@actana/shared/core-cert-material";
import {
  mintFreshMaterial,
  persistMaterialToFile,
  type PersistedMaterial,
} from "@actana/shared/core-material-store";

// First run in a container is the only place a Core mints its own identity
// without `actana setup` (ADR 0016 D13/D17). The daemon mints and persists into
// the volume; every later boot loads, so `docker compose restart` is a no-op for
// pairing and `down -v` is the only thing that unpairs.
//
// **Nothing is emitted, on any boot (#287).** First run used to write a
// `registration-blob.txt` beside the material and hand the blob back to be
// printed once. That hand-carry is gone and so are the assertions about it —
// deleted rather than skipped, because there is no artifact left for them to be
// about. A client enrolls by spending a code from `actana pair new`, which
// `core-pairing-routes.test.ts` and `actana-pair.test.ts` cover.

/**
 * A previous boot's material — real certificates, minted once for the suite.
 *
 * Placeholder PEM strings would do for a store that only type-checks its
 * fields, and this fixture used to be exactly that. Since #348 the load path
 * checks the CA the identity chains to, so material that is not an identity is
 * refused — correctly, and `core-material-identity.test.ts` is where that
 * refusal is asserted. Minting is ~200 ms, once.
 */
let sample: PersistedMaterial;

/**
 * What a machine installed before the Harness → Core rename carries.
 *
 * Real certificates under the old CA name, because the point of the fixture is
 * that they are *valid* — the review's correction is that this material works
 * and must keep booting, and a placeholder string could not show that.
 */
let preRename: PersistedMaterial;

async function mintPreRenameMaterial(base: PersistedMaterial): Promise<PersistedMaterial> {
  const notBefore = new Date();
  const ca = await selfsigned.generate(
    [
      { name: "commonName", value: "mission-control-harness-ca" },
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
    ...base,
    caCert: ca.cert,
    caKey: ca.private,
    serverCert: server.cert,
    serverKey: server.key,
  };
}

beforeAll(async () => {
  sample = await mintFreshMaterial(["core.example.test"]);
  preRename = await mintPreRenameMaterial(sample);
});

let dir: string;
let materialFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-first-run-"));
  materialFile = path.join(dir, "material.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const options = {
  publicHosts: ["core.example.test"],
  publicHostDeclared: true,
};

describe("loadOrMintMaterial — the file is absent", () => {
  it("mints and persists material at the requested path", async () => {
    const result = await loadOrMintMaterial({ materialFile, ...options });

    expect(fs.existsSync(materialFile)).toBe(true);
    // Persisted bytes are the bytes the next boot loads — not a re-mint.
    const persisted = JSON.parse(fs.readFileSync(materialFile, "utf8")) as PersistedMaterial;
    expect(persisted.coreId).toBe(result.material.coreId);
    expect(persisted.caKey).toBe(result.material.caKey);
    expect(persisted.bearerSecret).toBe(result.material.bearerSecret);
  });

  it("creates the parent directory when the volume is empty", async () => {
    const nested = path.join(dir, "config", "material.json");
    await loadOrMintMaterial({ materialFile: nested, ...options });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("restricts the material file to the owner", async () => {
    await loadOrMintMaterial({ materialFile, ...options });
    // Private keys — same 0600 the install path writes.
    expect(fs.statSync(materialFile).mode & 0o777).toBe(0o600);
  });
});

describe("loadOrMintMaterial — the identity on disk cannot be served (#348)", () => {
  it("refuses material that could never complete a handshake, naming the file", async () => {
    // The load path's half of `checkMaterialIdentity`: the daemon stops at
    // boot with a sentence, instead of presenting an identity that fails at a
    // client as `wrong version number`.
    const stranger = await mintFreshMaterial(["core.example.test"]);
    persistMaterialToFile(materialFile, { ...sample, serverCert: stranger.serverCert });

    await expect(loadOrMintMaterial({ materialFile, ...options })).rejects.toThrow(
      /cannot be used as this Core's identity/,
    );
    await expect(loadOrMintMaterial({ materialFile, ...options })).rejects.toThrow(
      /actana setup/,
    );
  });

  it("boots on material from before the rename rather than refusing it", async () => {
    // The review's correction, pinned: the Harness-era CA is not the fault in
    // #348 and this daemon serves it. Refusing here would brick a working
    // install and cost every paired client its pairing.
    persistMaterialToFile(materialFile, preRename);

    const result = await loadOrMintMaterial({ materialFile, ...options });

    expect(result.material.caCert).toBe(preRename.caCert);
    expect(result.material.coreId).toBe(preRename.coreId);
  });

  it("leaves the file alone — the operator decides what to discard", async () => {
    persistMaterialToFile(materialFile, { ...sample, serverKey: "not a key" });
    const before = fs.readFileSync(materialFile, "utf8");

    await expect(loadOrMintMaterial({ materialFile, ...options })).rejects.toThrow();

    expect(fs.readFileSync(materialFile, "utf8")).toBe(before);
  });
});

describe("loadOrMintMaterial — the file is present", () => {
  it("loads the persisted identity exactly as it was written", async () => {
    persistMaterialToFile(materialFile, sample);

    const result = await loadOrMintMaterial({ materialFile, ...options });

    expect(result.material).toEqual(sample);
    expect(result.certAction).toBe("unchanged");
  });

  it("leaves the persisted bytes untouched across restarts", async () => {
    const first = await loadOrMintMaterial({ materialFile, ...options });
    const bytes = fs.readFileSync(materialFile, "utf8");

    const second = await loadOrMintMaterial({ materialFile, ...options });

    expect(second.material.coreId).toBe(first.material.coreId);
    expect(fs.readFileSync(materialFile, "utf8")).toBe(bytes);
  });

  // #287: nothing beside the material file, ever. A `registration-blob.txt`
  // reappearing would be the hand-carry back, and it would be a credential
  // sitting in a volume with no one who needs it.
  it("writes nothing beside the material file", async () => {
    await loadOrMintMaterial({ materialFile, ...options });
    expect(fs.readdirSync(dir)).toEqual(["material.json"]);
  });

  it("throws rather than re-minting when the material is unreadable", async () => {
    fs.writeFileSync(materialFile, "{ not json");

    // Re-minting here would lock out every paired Panel to paper over a
    // corrupt file — the operator has to decide, so the daemon refuses.
    await expect(loadOrMintMaterial({ materialFile, ...options })).rejects.toThrow(
      materialFile,
    );
  });
});

describe("loadOrMintMaterial — ACTANA_PUBLIC_HOST moved", () => {
  // In a container the public host is an env var, so a typo fires this path.
  // Re-minting here (the old behaviour) unpaired every Panel over that typo;
  // only the server cert may change now (ADR 0016 D18).
  it("re-issues only the server cert and keeps the identity", async () => {
    const first = await loadOrMintMaterial({ materialFile, ...options });

    const moved = await loadOrMintMaterial({
      materialFile,
      ...options,
      publicHosts: ["core2.example.test"],
    });

    expect(moved.certAction).toBe("moved");
    expect(moved.material.coreId).toBe(first.material.coreId);
    expect(moved.material.bearerSecret).toBe(first.material.bearerSecret);
    expect(moved.material.caCert).toBe(first.material.caCert);
    expect(moved.material.caKey).toBe(first.material.caKey);
    expect(moved.material.clientCert).toBe(first.material.clientCert);
    expect(moved.material.clientKey).toBe(first.material.clientKey);
    expect(moved.material.serverCert).not.toBe(first.material.serverCert);
  });

  it("signs the new cert for the new host with the CA the client pinned", async () => {
    const first = await loadOrMintMaterial({ materialFile, ...options });
    const pinnedCa = first.material.caCert;

    const moved = await loadOrMintMaterial({
      materialFile,
      ...options,
      publicHosts: ["core2.example.test"],
    });

    const server = new X509Certificate(moved.material.serverCert);
    expect(server.verify(createPublicKey(pinnedCa))).toBe(true);
    expect(server.subjectAltName).toContain("core2.example.test");
  });

  it("persists the re-issued cert so the next boot is a plain load", async () => {
    await loadOrMintMaterial({ materialFile, ...options });
    const moved = await loadOrMintMaterial({
      materialFile,
      ...options,
      publicHosts: ["core2.example.test"],
    });

    const again = await loadOrMintMaterial({
      materialFile,
      ...options,
      publicHosts: ["core2.example.test"],
    });

    expect(again.certAction).toBe("unchanged");
    expect(again.material.serverCert).toBe(moved.material.serverCert);
  });

  it("re-issues quietly for material written before the host was recorded", async () => {
    const minted = await loadOrMintMaterial({ materialFile, ...options });
    const { serverHosts: _recorded, ...legacy } = minted.material;
    fs.writeFileSync(materialFile, JSON.stringify(legacy));

    // An unrecorded host is an unknown one, not a moved one: the SAN is
    // re-signed once for the host in hand and recorded, but the boot after an
    // upgrade must not tell an operator their Core moved when it did not.
    const boot = await loadOrMintMaterial({ materialFile, ...options });

    expect(boot.certAction).toBe("backfilled");
    expect(boot.material.coreId).toBe(minted.material.coreId);
    expect(boot.material.serverHosts).toEqual(options.publicHosts);
  });

  it("leaves the cert alone when the public host was never declared", async () => {
    const first = await loadOrMintMaterial({ materialFile, ...options });

    // A daemon started without `ACTANA_PUBLIC_HOST` falls back to its bind
    // address. That is a guess, and re-signing the SAN with a guess would take
    // a working Core off its own address and onto 127.0.0.1.
    const boot = await loadOrMintMaterial({
      materialFile,
      ...options,
      publicHosts: ["127.0.0.1"],
      publicHostDeclared: false,
    });

    expect(boot.certAction).toBe("unchanged");
    expect(boot.material.serverCert).toBe(first.material.serverCert);
  });
});

// ─── Several public hosts in one certificate (#347) ─────────────────────────
//
// The daemon's boot path is where a comma-separated `ACTANA_PUBLIC_HOST`
// becomes a certificate, so this is where the two halves of the promise are
// checked against the artefact: several hosts really are covered, and one host
// still behaves exactly as it did before there could be several.

/** The SAN entries a verifier sees, read off the certificate itself. */
function sanEntries(certPem: string): string[] {
  return (new X509Certificate(certPem).subjectAltName ?? "")
    .split(", ")
    .filter((entry) => entry.length > 0);
}

describe("loadOrMintMaterial — several public hosts", () => {
  it("mints one certificate covering every configured host", async () => {
    const minted = await loadOrMintMaterial({
      materialFile,
      publicHosts: ["core", "10.0.0.5"],
      publicHostDeclared: true,
    });

    expect(sanEntries(minted.material.serverCert)).toEqual([
      "DNS:core",
      "IP Address:10.0.0.5",
      "DNS:localhost",
      "IP Address:127.0.0.1",
    ]);
    expect(minted.material.serverHosts).toEqual(["core", "10.0.0.5"]);
  });

  // The regression this ticket exists to end: a Core reachable two ways used
  // to need its one address changed, which re-signed the certificate for the
  // new name only and unpaired everything still dialling the old one. Adding
  // an address now keeps the old one covered.
  it("keeps the original host covered when a second one is added", async () => {
    const first = await loadOrMintMaterial({
      materialFile,
      publicHosts: ["core"],
      publicHostDeclared: true,
    });

    const widened = await loadOrMintMaterial({
      materialFile,
      publicHosts: ["core", "10.0.0.5"],
      publicHostDeclared: true,
    });

    // `widened`, not `moved`: every previously recorded host is still covered,
    // so no paired client lost anything and the daemon must not advise one to
    // re-address a Panel or pair again (#347 review R1).
    expect(widened.certAction).toBe("widened");
    expect(widened.addedHosts).toEqual(["10.0.0.5"]);
    expect(sanEntries(widened.material.serverCert)).toContain("DNS:core");
    expect(sanEntries(widened.material.serverCert)).toContain("IP Address:10.0.0.5");
    // And nothing a paired client pinned has changed — the CA it validates
    // against is the one it already holds (ADR 0016 D18).
    expect(widened.material.caCert).toBe(first.material.caCert);
    expect(widened.material.coreId).toBe(first.material.coreId);
    expect(widened.material.coreUuid).toBe(first.material.coreUuid);
    expect(
      new X509Certificate(widened.material.serverCert).verify(
        createPublicKey(first.material.caCert),
      ),
    ).toBe(true);
  });

  // **The compatibility landmine, proved rather than asserted.** A Docker
  // Compose file that sets one `ACTANA_PUBLIC_HOST` must not need editing and
  // must behave exactly as it does now: the same SAN list, and — the half that
  // would actually hurt — no re-issue on the boot after the upgrade, because a
  // re-issue is what invalidates nothing but looks alarming in a log and costs
  // a certificate for no reason.
  it("a single host mints what it always minted and never re-issues on restart", async () => {
    const first = await loadOrMintMaterial({
      materialFile,
      publicHosts: ["core"],
      publicHostDeclared: true,
    });
    expect(first.certAction).toBe("unchanged");
    expect(sanEntries(first.material.serverCert)).toEqual([
      "DNS:core",
      "DNS:localhost",
      "IP Address:127.0.0.1",
    ]);

    const bytes = fs.readFileSync(materialFile, "utf8");
    const restart = await loadOrMintMaterial({
      materialFile,
      publicHosts: ["core"],
      publicHostDeclared: true,
    });

    expect(restart.certAction).toBe("unchanged");
    expect(restart.material.serverCert).toBe(first.material.serverCert);
    expect(fs.readFileSync(materialFile, "utf8")).toBe(bytes);
  });

  // A Core installed before #347 has a `serverHost` string and no list. Its
  // next boot must be a plain load: reading the old field as a list of one is
  // what keeps a rename from looking like a moved Core.
  it("boots material written before the list existed without re-issuing", async () => {
    const minted = await loadOrMintMaterial({
      materialFile,
      publicHosts: ["core"],
      publicHostDeclared: true,
    });
    const { serverHosts: _listed, ...legacy } = minted.material;
    fs.writeFileSync(materialFile, JSON.stringify({ ...legacy, serverHost: "core" }));

    const boot = await loadOrMintMaterial({
      materialFile,
      publicHosts: ["core"],
      publicHostDeclared: true,
    });

    expect(boot.certAction).toBe("unchanged");
    expect(boot.material.serverCert).toBe(minted.material.serverCert);
    expect(boot.material.serverHosts).toEqual(["core"]);
  });
});

// ─── widening is not moving (#347 review R1) ────────────────────────────────
//
// Any edit to the list re-issues the certificate. Only some edits cost a paired
// client anything, and the daemon's advice is written from this distinction:
// telling an operator who just *added* an address to re-address their Panel or
// pair again would charge them the exact cost #347 exists to remove.

describe("loadOrMintMaterial — a widened list is not a moved one", () => {
  async function bootedOn(hosts: string[]) {
    return loadOrMintMaterial({ materialFile, publicHosts: hosts, publicHostDeclared: true });
  }

  it("reports a widening as its own action, naming what was added", async () => {
    await bootedOn(["core"]);

    const widened = await bootedOn(["core", "10.0.0.5", "core.example"]);

    expect(widened.certAction).toBe("widened");
    expect(widened.addedHosts).toEqual(["10.0.0.5", "core.example"]);
    // And it really was re-signed — a widening is not a no-op, it is a re-issue
    // whose consequences are simply nothing an operator has to act on.
    expect(sanEntries(widened.material.serverCert)).toContain("IP Address:10.0.0.5");
  });

  it("still calls it a widening when the addition is not last", async () => {
    await bootedOn(["core"]);
    const widened = await bootedOn(["10.0.0.5", "core"]);
    expect(widened.certAction).toBe("widened");
    expect(widened.addedHosts).toEqual(["10.0.0.5"]);
  });

  it("reports a dropped host as a move, because a client is still dialling it", async () => {
    await bootedOn(["core", "10.0.0.5"]);

    const moved = await bootedOn(["core"]);

    expect(moved.certAction).toBe("moved");
    expect(moved.addedHosts).toEqual([]);
    expect(sanEntries(moved.material.serverCert)).not.toContain("IP Address:10.0.0.5");
  });

  it("reports a reorder as a move — nothing was added and the primary changed", async () => {
    await bootedOn(["core", "10.0.0.5"]);

    const reordered = await bootedOn(["10.0.0.5", "core"]);

    // The default endpoint a new pairing hands back is not what it was, so this
    // is not the reassuring case even though every host is still covered.
    expect(reordered.certAction).toBe("moved");
    expect(reordered.addedHosts).toEqual([]);
  });

  it("leaves backfilled and unchanged carrying no additions", async () => {
    const minted = await bootedOn(["core"]);
    expect(minted.addedHosts).toEqual([]);

    const { serverHosts: _listed, ...legacy } = minted.material;
    fs.writeFileSync(materialFile, JSON.stringify({ ...legacy, serverHosts: [] }));

    const backfilled = await bootedOn(["core"]);
    expect(backfilled.certAction).toBe("backfilled");
    expect(backfilled.addedHosts).toEqual([]);
  });
});
