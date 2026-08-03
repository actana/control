import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  persistMaterial,
  loadMaterial,
  materialFilePath,
  type PersistedMaterial,
} from "../harness-material-store";

// The material store persists the Harness's cert material + bearer secret to
// disk so the daemon can reload the same CA + certs across reboots (ADR 0003
// "Auto-start"). Without persistence the daemon would generate fresh certs on
// each start, invalidating the Panel's pinned client cert. Re-running
// `harness install` overwrites the file (reissue); the SQLite DB lives in a
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
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-material-test-"));
}

describe("harness material store", () => {
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
      const nested = path.join(dir, "nested", "harness");
      persistMaterial(nested, sample);
      expect(loadMaterial(nested)).toEqual(sample);
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
});
