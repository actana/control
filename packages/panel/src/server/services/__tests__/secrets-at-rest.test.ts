import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-secrets-at-rest-test-"));

const { SECRETS_KEY_FILENAME, openSecret, resetSecretsKeyForTests, sealSecret } = await import(
  "../secrets-at-rest"
);

let dataDir: string;
let dirCount = 0;

beforeEach(() => {
  dataDir = path.join(tmpRoot, `d${dirCount++}`);
  process.env.AC_PANEL_DATA_DIR = dataDir;
  delete process.env.AC_SECRETS_KEY;
  resetSecretsKeyForTests();
});

afterEach(() => {
  delete process.env.AC_SECRETS_KEY;
  resetSecretsKeyForTests();
});

function keyFile(): string {
  return path.join(dataDir, SECRETS_KEY_FILENAME);
}

const SECRET = JSON.stringify({ bearer: "top-secret-bearer", clientKey: "-----BEGIN KEY-----" });

describe("secrets at rest", () => {
  it("round-trips a secret through the auto-generated key file", () => {
    const sealed = sealSecret(SECRET);
    expect(openSecret(sealed)).toBe(SECRET);
  });

  it("generates the key file in the data directory, owner-readable only", () => {
    sealSecret(SECRET);
    expect(fs.existsSync(keyFile())).toBe(true);
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
  });

  it("leaks nothing readable into the ciphertext", () => {
    const sealed = sealSecret(SECRET);
    expect(sealed.toString("utf8")).not.toContain("top-secret-bearer");
    expect(sealed.toString("utf8")).not.toContain("BEGIN KEY");
  });

  it("never produces the same ciphertext twice for the same plaintext", () => {
    expect(sealSecret(SECRET).equals(sealSecret(SECRET))).toBe(false);
  });

  it("cannot be opened by a Panel whose key file is a different one", () => {
    const sealed = sealSecret(SECRET);
    // A casual copy of panel.db onto a machine with its own key file.
    dataDir = path.join(tmpRoot, "elsewhere");
    process.env.AC_PANEL_DATA_DIR = dataDir;
    resetSecretsKeyForTests();
    expect(openSecret(sealed)).toBeNull();
  });

  it("returns null for a tampered ciphertext rather than plaintext garbage", () => {
    const sealed = sealSecret(SECRET);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 0xff;
    expect(openSecret(tampered)).toBeNull();
  });

  it("returns null for a blob that isn't one of ours", () => {
    expect(openSecret(Buffer.from("not a sealed blob"))).toBeNull();
    expect(openSecret(Buffer.alloc(0))).toBeNull();
  });

  describe("AC_SECRETS_KEY", () => {
    const HEX_KEY = "a".repeat(64);

    it("overrides the key file, and no key file is written", () => {
      process.env.AC_SECRETS_KEY = HEX_KEY;
      resetSecretsKeyForTests();
      const sealed = sealSecret(SECRET);
      expect(openSecret(sealed)).toBe(SECRET);
      expect(fs.existsSync(keyFile())).toBe(false);
    });

    it("takes precedence over an existing key file", () => {
      const sealedWithFile = sealSecret(SECRET);
      process.env.AC_SECRETS_KEY = HEX_KEY;
      resetSecretsKeyForTests();
      expect(openSecret(sealedWithFile)).toBeNull();
    });

    it("accepts a base64 32-byte key", () => {
      process.env.AC_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
      resetSecretsKeyForTests();
      expect(openSecret(sealSecret(SECRET))).toBe(SECRET);
    });

    it("refuses to boot on a key that is not 32 bytes", () => {
      process.env.AC_SECRETS_KEY = "too-short";
      resetSecretsKeyForTests();
      expect(() => sealSecret(SECRET)).toThrow(/AC_SECRETS_KEY/);
    });
  });
});
