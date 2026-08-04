import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { X509Certificate, createPublicKey } from "node:crypto";
import {
  persistMaterial,
  loadMaterial,
  materialFilePath,
  mintFreshMaterial,
  reissueServerCert,
  serverCertCoversHost,
  type PersistedMaterial,
} from "../core-material-store";

// The material store persists the Core's cert material + bearer secret to
// disk so the daemon can reload the same CA + certs across reboots (ADR 0003
// "Auto-start"). Without persistence the daemon would generate fresh certs on
// each start, invalidating the Panel's pinned client cert. Re-running
// `core install` overwrites the file (reissue); the SQLite DB lives in a
// separate user-data dir and is never touched.

const sample: PersistedMaterial = {
  caCert: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
  caKey: "-----BEGIN PRIVATE KEY-----\nCAKEY\n-----END PRIVATE KEY-----",
  serverCert: "-----BEGIN CERTIFICATE-----\nSERVER\n-----END CERTIFICATE-----",
  serverKey: "-----BEGIN PRIVATE KEY-----\nSERVERKEY\n-----END PRIVATE KEY-----",
  clientCert: "-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----",
  clientKey: "-----BEGIN PRIVATE KEY-----\nCLIENTKEY\n-----END PRIVATE KEY-----",
  bearerSecret: "deadbeef".repeat(8),
  coreId: "core_abcdef0123456789",
  serverHost: "10.0.0.5",
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-material-test-"));
}

describe("core material store", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("persistMaterial / loadMaterial", () => {
    it("round-trips material to disk", () => {
      persistMaterial(dir, sample);
      const loaded = loadMaterial(dir);
      expect(loaded).toEqual(sample);
    });

    it("writes to material.json inside the config dir", () => {
      persistMaterial(dir, sample);
      expect(fs.existsSync(materialFilePath(dir))).toBe(true);
    });

    it("returns null when no material file exists", () => {
      expect(loadMaterial(dir)).toBeNull();
    });

    it("returns null for a corrupt JSON file", () => {
      fs.writeFileSync(materialFilePath(dir), "{not json");
      expect(loadMaterial(dir)).toBeNull();
    });

    it("returns null when required fields are missing", () => {
      const partial = { caCert: "x", caKey: "y" } as unknown as PersistedMaterial;
      fs.writeFileSync(materialFilePath(dir), JSON.stringify(partial));
      expect(loadMaterial(dir)).toBeNull();
    });

    it("returns null when fields have wrong types", () => {
      const bad = { ...sample, caCert: 123 } as unknown as PersistedMaterial;
      fs.writeFileSync(materialFilePath(dir), JSON.stringify(bad));
      expect(loadMaterial(dir)).toBeNull();
    });

    it("overwrites existing material on re-persist (reissue)", () => {
      persistMaterial(dir, sample);
      const reissued: PersistedMaterial = {
        ...sample,
        coreId: "core_new123",
        bearerSecret: "aabbccdd".repeat(8),
      };
      persistMaterial(dir, reissued);
      expect(loadMaterial(dir)).toEqual(reissued);
    });

    it("creates the config dir if it does not exist", () => {
      const nested = path.join(dir, "nested", "core");
      persistMaterial(nested, sample);
      expect(loadMaterial(nested)).toEqual(sample);
    });

    it("loads material written before serverHost existed as an unknown host", () => {
      const { serverHost, ...legacy } = sample;
      fs.writeFileSync(materialFilePath(dir), JSON.stringify(legacy));

      // The identity is intact — only the SAN's provenance is unknown, and
      // rejecting the file over that would unpair a Panel to save a field.
      const loaded = loadMaterial(dir);
      expect(loaded).toEqual({ ...legacy, serverHost: "" });
      expect(serverCertCoversHost(loaded!, serverHost)).toBe(false);
    });

    it("restricts file permissions to owner-only (0o600)", () => {
      persistMaterial(dir, sample);
      const stat = fs.statSync(materialFilePath(dir));
      // On POSIX systems the mode should be 0o600. On Windows this is a no-op.
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });
  });

  // A moved public host used to re-mint everything, which locked out every
  // paired Panel over what is usually a typo'd env var (ADR 0016 D18).
  describe("reissueServerCert", () => {
    it("keeps every credential a Panel pinned and replaces only the server cert", async () => {
      const minted = await mintFreshMaterial("10.0.0.5");

      const moved = await reissueServerCert(minted, "core.example.test");

      expect(moved.coreId).toBe(minted.coreId);
      expect(moved.bearerSecret).toBe(minted.bearerSecret);
      expect(moved.caCert).toBe(minted.caCert);
      expect(moved.caKey).toBe(minted.caKey);
      expect(moved.clientCert).toBe(minted.clientCert);
      expect(moved.clientKey).toBe(minted.clientKey);
      expect(moved.serverCert).not.toBe(minted.serverCert);
      expect(moved.serverKey).not.toBe(minted.serverKey);
    });

    it("signs the new cert with the CA the Panel already pinned", async () => {
      const minted = await mintFreshMaterial("10.0.0.5");

      const moved = await reissueServerCert(minted, "core.example.test");

      // This is the whole point: the Panel validates the Core against the CA
      // in the blob it holds, so that CA must still vouch for the new cert.
      const server = new X509Certificate(moved.serverCert);
      expect(server.verify(createPublicKey(minted.caCert))).toBe(true);
      expect(server.subjectAltName).toContain("core.example.test");
      expect(server.subjectAltName).not.toContain("10.0.0.5");
    });

    it("records the host it signed for, so the next boot knows it is covered", async () => {
      const minted = await mintFreshMaterial("10.0.0.5");
      expect(serverCertCoversHost(minted, "10.0.0.5")).toBe(true);
      expect(serverCertCoversHost(minted, "core.example.test")).toBe(false);

      const moved = await reissueServerCert(minted, "core.example.test");

      expect(moved.serverHost).toBe("core.example.test");
      expect(serverCertCoversHost(moved, "core.example.test")).toBe(true);
    });
  });
});
