import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encodeRegistrationBlob } from "@actana/shared/registration-blob";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cores-test-"));
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { getPanelDb } = await import("../../panel-db");
const { createOperator, operatorExists } = await import("../operator");
const {
  RegistrationBlobError,
  advanceCoreCursor,
  getCore,
  getCoreSecrets,
  listCores,
  registerCoreFromRegistrationBlob,
  removeCore,
  renameCore,
} = await import("../cores");

const BEARER = "bearer.eyJjb3JlSWQiOiJjb3JlXzEifQ.sig";
const CLIENT_KEY = "-----BEGIN PRIVATE KEY-----\nMIIsecret\n-----END PRIVATE KEY-----";

function registrationBlob(overrides: Partial<Parameters<typeof encodeRegistrationBlob>[0]> = {}): string {
  return encodeRegistrationBlob({
    endpoint: "wss://10.0.0.5:7777",
    label: "prod-vm-1",
    caCert: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
    clientCert: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
    clientKey: CLIENT_KEY,
    bearer: BEARER,
    ...overrides,
  });
}

function coreRowCount(): number {
  return (getPanelDb().prepare("SELECT COUNT(*) AS n FROM cores").get() as { n: number }).n;
}

function secretRowCount(): number {
  return (getPanelDb().prepare("SELECT COUNT(*) AS n FROM core_secrets").get() as { n: number }).n;
}

beforeEach(() => {
  const db = getPanelDb();
  db.prepare("DELETE FROM core_secrets").run();
  db.prepare("DELETE FROM cores").run();
  if (!operatorExists()) createOperator({ name: "Test Operator", password: "test-password" });
});

describe("Core registry", () => {
  it("registers a Core from a pairing token", () => {
    const core = registerCoreFromRegistrationBlob(registrationBlob());
    expect(core.endpoint).toBe("wss://10.0.0.5:7777");
    expect(core.label).toBe("prod-vm-1");
    expect(core.lastEventId).toBe(0);
    expect(listCores().map((c) => c.id)).toEqual([core.id]);
    expect(getCore(core.id)?.endpoint).toBe("wss://10.0.0.5:7777");
  });

  it("keeps the secrets available to the dialer", () => {
    const core = registerCoreFromRegistrationBlob(registrationBlob());
    expect(getCoreSecrets(core.id)).toEqual({
      caCert: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
      clientCert: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
      clientKey: CLIENT_KEY,
      bearer: BEARER,
    });
  });

  it("stores no readable secret material in the database", () => {
    registerCoreFromRegistrationBlob(registrationBlob());
    const rows = getPanelDb().prepare("SELECT sealed FROM core_secrets").all() as {
      sealed: Uint8Array;
    }[];
    expect(rows).toHaveLength(1);
    const blob = Buffer.from(rows[0]!.sealed).toString("utf8");
    expect(blob).not.toContain(BEARER);
    expect(blob).not.toContain("PRIVATE KEY");
    // Nor anywhere else in the file — the registry row is plaintext by design,
    // but it must not carry the secret half.
    const dump = fs.readFileSync(path.join(process.env.AC_PANEL_DATA_DIR!, "panel.db"));
    expect(dump.includes(Buffer.from(BEARER))).toBe(false);
  });

  it("falls back to the endpoint host when the token carries no label", () => {
    const core = registerCoreFromRegistrationBlob(registrationBlob({ label: "" }));
    expect(core.label).toBe("10.0.0.5");
  });

  it("rejects a malformed pairing token and writes nothing", () => {
    expect(() => registerCoreFromRegistrationBlob("not-a-token")).toThrow(RegistrationBlobError);
    expect(coreRowCount()).toBe(0);
    expect(secretRowCount()).toBe(0);
  });

  it("rejects a token that decodes but is missing its secret half", () => {
    const truncated = Buffer.from(
      JSON.stringify({ endpoint: "wss://10.0.0.5:7777", label: "x" }),
      "utf8",
    ).toString("base64");
    expect(() => registerCoreFromRegistrationBlob(truncated)).toThrow(RegistrationBlobError);
    expect(coreRowCount()).toBe(0);
  });

  it("rejects a blob whose secret fields are blank", () => {
    // Well-formed enough to decode, useless to dial with. Registering it would
    // take the endpoint and leave a Core that can never connect and can't be
    // re-paired without a manual removal.
    for (const blank of ["caCert", "clientCert", "clientKey", "bearer"] as const) {
      expect(() => registerCoreFromRegistrationBlob(registrationBlob({ [blank]: "" }))).toThrow(
        RegistrationBlobError,
      );
    }
    expect(coreRowCount()).toBe(0);
    expect(secretRowCount()).toBe(0);
  });

  it("rejects a plaintext ws:// endpoint — mTLS is not optional", () => {
    const downgraded = Buffer.from(
      JSON.stringify({
        endpoint: "ws://10.0.0.5:7777",
        label: "x",
        caCert: "ca",
        clientCert: "cert",
        clientKey: "key",
        bearer: BEARER,
      }),
      "utf8",
    ).toString("base64");
    expect(() => registerCoreFromRegistrationBlob(downgraded)).toThrow(RegistrationBlobError);
    expect(coreRowCount()).toBe(0);
  });

  it("refuses a second registration of the same endpoint, leaving the first intact", () => {
    const first = registerCoreFromRegistrationBlob(registrationBlob());
    expect(() => registerCoreFromRegistrationBlob(registrationBlob({ label: "duplicate" }))).toThrow(
      RegistrationBlobError,
    );
    expect(listCores().map((c) => c.id)).toEqual([first.id]);
    expect(getCore(first.id)?.label).toBe("prod-vm-1");
    expect(secretRowCount()).toBe(1);
  });

  describe("the Panel-owned cursor", () => {
    it("advances and is read back off the registry row", () => {
      const core = registerCoreFromRegistrationBlob(registrationBlob());
      advanceCoreCursor(core.id, 42);
      expect(getCore(core.id)?.lastEventId).toBe(42);
    });

    it("never rewinds", () => {
      const core = registerCoreFromRegistrationBlob(registrationBlob());
      advanceCoreCursor(core.id, 42);
      advanceCoreCursor(core.id, 7);
      expect(getCore(core.id)?.lastEventId).toBe(42);
    });

    it("ignores nonsense rather than corrupting the replay position", () => {
      const core = registerCoreFromRegistrationBlob(registrationBlob());
      advanceCoreCursor(core.id, 42);
      advanceCoreCursor(core.id, Number.NaN);
      advanceCoreCursor(core.id, -1);
      expect(getCore(core.id)?.lastEventId).toBe(42);
    });
  });

  describe("renaming", () => {
    it("takes the operator's alias and bumps updated_at", () => {
      const core = registerCoreFromRegistrationBlob(registrationBlob());
      // Age the row first: registration and the rename can land in the same
      // millisecond, and a bump asserted against the wall clock would flake.
      getPanelDb().prepare("UPDATE cores SET updated_at = 0 WHERE id = ?").run(core.id);
      const renamed = renameCore(core.id, "build-box");
      expect(renamed?.label).toBe("build-box");
      expect(getCore(core.id)?.label).toBe("build-box");
      expect(renamed?.updatedAt).toBeGreaterThan(0);
    });

    it("trims and caps at 120 characters, like registration does", () => {
      const core = registerCoreFromRegistrationBlob(registrationBlob());
      expect(renameCore(core.id, "  spaced out  ")?.label).toBe("spaced out");
      expect(renameCore(core.id, "x".repeat(200))?.label).toBe("x".repeat(120));
    });

    it("falls back to the endpoint host rather than leaving a blank row", () => {
      const core = registerCoreFromRegistrationBlob(registrationBlob());
      expect(renameCore(core.id, "   ")?.label).toBe("10.0.0.5");
      expect(renameCore(core.id, "")?.label).toBe("10.0.0.5");
    });

    it("touches nothing but the label — endpoint, cursor and secrets are left alone", () => {
      const core = registerCoreFromRegistrationBlob(registrationBlob());
      advanceCoreCursor(core.id, 17);
      renameCore(core.id, "build-box");
      const after = getCore(core.id);
      expect(after?.endpoint).toBe("wss://10.0.0.5:7777");
      expect(after?.lastEventId).toBe(17);
      expect(after?.createdAt).toBe(core.createdAt);
      expect(getCoreSecrets(core.id)?.bearer).toBe(BEARER);
    });

    it("reports an unknown id rather than writing a row", () => {
      expect(renameCore("core_nope", "build-box")).toBeNull();
      expect(coreRowCount()).toBe(0);
    });
  });

  describe("removal", () => {
    it("drops the registry row, the secrets, and the cursor", () => {
      const core = registerCoreFromRegistrationBlob(registrationBlob());
      advanceCoreCursor(core.id, 99);
      expect(removeCore(core.id)).toBe(true);
      expect(getCore(core.id)).toBeNull();
      expect(getCoreSecrets(core.id)).toBeNull();
      expect(coreRowCount()).toBe(0);
      expect(secretRowCount()).toBe(0);
    });

    it("frees the endpoint for a fresh pairing", () => {
      const core = registerCoreFromRegistrationBlob(registrationBlob());
      removeCore(core.id);
      const again = registerCoreFromRegistrationBlob(registrationBlob());
      expect(again.id).not.toBe(core.id);
      expect(again.lastEventId).toBe(0);
    });

    it("reports an unknown id rather than pretending", () => {
      expect(removeCore("core_nope")).toBe(false);
    });
  });
});
