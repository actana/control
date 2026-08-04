import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  REGISTRATION_BLOB_FILENAME,
  buildRegistrationBlob,
  registrationBlobPath,
  formatRegistrationBlobNotice,
  loadOrMintMaterial,
} from "../core-first-run";
import { persistMaterialToFile, type PersistedMaterial } from "../core-material-store";
import { decodeRegistrationBlob } from "@actana/shared/registration-blob";
import { verifyBearer } from "@actana/shared/core-link-bearer";

// First run in a container is the only place a Core mints its own identity
// without `actana setup` (ADR 0016 D13/D17). The daemon mints, persists into
// the volume, writes the blob beside the material and prints it once; every
// later boot loads and stays silent, so `docker compose restart` is a no-op
// for pairing and `down -v` is the only thing that unpairs.

const sample: PersistedMaterial = {
  caCert: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
  caKey: "-----BEGIN PRIVATE KEY-----\nCAKEY\n-----END PRIVATE KEY-----",
  serverCert: "-----BEGIN CERTIFICATE-----\nSERVER\n-----END CERTIFICATE-----",
  serverKey: "-----BEGIN PRIVATE KEY-----\nSERVERKEY\n-----END PRIVATE KEY-----",
  clientCert: "-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----",
  clientKey: "-----BEGIN PRIVATE KEY-----\nCLIENTKEY\n-----END PRIVATE KEY-----",
  bearerSecret: "deadbeef".repeat(8),
  coreId: "core_abcdef0123456789",
};

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
  publicHost: "core.example.test",
  port: 8443,
  label: "workshop",
  bearerDays: 365,
};

describe("registrationBlobPath", () => {
  it("puts the blob beside the material file", () => {
    expect(registrationBlobPath("/home/core/.actana/material.json")).toBe(
      `/home/core/.actana/${REGISTRATION_BLOB_FILENAME}`,
    );
  });
});

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

  it("writes the blob beside the material as the bare paste string", async () => {
    const result = await loadOrMintMaterial({ materialFile, ...options });

    expect(result.blob).not.toBeNull();
    const onDisk = fs.readFileSync(registrationBlobPath(materialFile), "utf8");
    // `docker compose exec core cat registration-blob.txt` must yield something
    // pasteable, so the file holds the blob and nothing else.
    expect(onDisk.trim()).toBe(result.blob);
    expect(decodeRegistrationBlob(onDisk)).not.toBeNull();
  });

  it("builds a blob the Panel can pair with", async () => {
    const result = await loadOrMintMaterial({ materialFile, ...options });

    const decoded = decodeRegistrationBlob(result.blob ?? "");
    expect(decoded).not.toBeNull();
    expect(decoded?.endpoint).toBe("wss://core.example.test:8443");
    expect(decoded?.caCert).toBe(result.material.caCert);
    expect(decoded?.clientCert).toBe(result.material.clientCert);
    expect(decoded?.clientKey).toBe(result.material.clientKey);
    // The bearer in the blob must verify against the secret the daemon keeps.
    const verified = verifyBearer(decoded?.bearer ?? "", result.material.bearerSecret);
    expect(verified).toMatchObject({ ok: true, coreId: result.material.coreId });
  });

  it("uses the label it was given rather than an empty string", async () => {
    const result = await loadOrMintMaterial({ materialFile, ...options });
    expect(decodeRegistrationBlob(result.blob ?? "")?.label).toBe("workshop");
  });

  it("restricts the material file to the owner", async () => {
    await loadOrMintMaterial({ materialFile, ...options });
    // Private keys — same 0600 the install path writes.
    expect(fs.statSync(materialFile).mode & 0o777).toBe(0o600);
  });
});

describe("loadOrMintMaterial — the file is present", () => {
  it("loads the persisted identity and prints nothing", async () => {
    persistMaterialToFile(materialFile, sample);

    const result = await loadOrMintMaterial({ materialFile, ...options });

    expect(result.material).toEqual(sample);
    // A restart must not re-print: the operator already paired, and a second
    // blob on stdout reads as "this Core moved".
    expect(result.blob).toBeNull();
  });

  it("leaves the persisted bytes untouched across restarts", async () => {
    const first = await loadOrMintMaterial({ materialFile, ...options });
    const bytes = fs.readFileSync(materialFile, "utf8");

    const second = await loadOrMintMaterial({ materialFile, ...options });

    expect(second.material.coreId).toBe(first.material.coreId);
    expect(fs.readFileSync(materialFile, "utf8")).toBe(bytes);
    expect(second.blob).toBeNull();
  });

  it("does not rewrite the blob file on a later boot", async () => {
    await loadOrMintMaterial({ materialFile, ...options });
    const blobFile = registrationBlobPath(materialFile);
    fs.writeFileSync(blobFile, "operator-edited");

    await loadOrMintMaterial({ materialFile, ...options });

    expect(fs.readFileSync(blobFile, "utf8")).toBe("operator-edited");
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

describe("buildRegistrationBlob", () => {
  it("carries the endpoint, label and Panel half of the mTLS pair", () => {
    const blob = buildRegistrationBlob(sample, {
      publicHost: "core",
      port: 9443,
      label: "second core",
      bearerDays: 30,
    });

    const decoded = decodeRegistrationBlob(blob);
    expect(decoded).toMatchObject({
      endpoint: "wss://core:9443",
      label: "second core",
      caCert: sample.caCert,
      clientCert: sample.clientCert,
      clientKey: sample.clientKey,
    });
    // The Core's own server key never leaves the machine — only the Panel's
    // half and the CA to pin do.
    expect(blob).not.toContain(Buffer.from(sample.serverKey).toString("base64"));
  });

  it("signs a bearer for the lease it was given", () => {
    const days = 30;
    const blob = buildRegistrationBlob(sample, {
      publicHost: "core",
      port: 9443,
      label: "",
      bearerDays: days,
    });

    const verified = verifyBearer(decodeRegistrationBlob(blob)?.bearer ?? "", sample.bearerSecret);
    expect(verified.ok).toBe(true);
    const expected = Date.now() + days * 24 * 60 * 60 * 1000;
    // Signed against now, so allow a second of clock drift across the call.
    expect(verified.ok && Math.abs(verified.exp - expected)).toBeLessThan(1000);
  });
});

describe("formatRegistrationBlobNotice", () => {
  it("prints the blob on a line of its own, unprefixed", () => {
    const notice = formatRegistrationBlobNotice("BLOB", "/home/core/.actana/blob.txt");
    // The sentinel form is for a supervising parent; this one is read by a
    // human tailing `docker compose logs`, so the blob must survive a copy.
    expect(notice).not.toContain("@@");
    expect(notice.split("\n")).toContain("BLOB");
    expect(notice).toContain("/home/core/.actana/blob.txt");
  });
});
