import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "../../__tests__/_panel-test-db";

const testDb = await openPanelTestDb();
const { createOperator } = await import("../operator");
const {
  CoreRegistryError,
  advanceCoreCursor,
  getCore,
  getCoreSecrets,
  listCores,
  registerCoreFromCredential,
  removeCore,
  renameCore,
} = await import("../cores");

type Credential = Parameters<typeof registerCoreFromCredential>[0];

const BEARER = "bearer.eyJjb3JlSWQiOiJjb3JlXzEifQ.sig";
const CLIENT_KEY = "-----BEGIN PRIVATE KEY-----\nMIIsecret\n-----END PRIVATE KEY-----";

/**
 * The credential a pairing hands back — the one door into the registry now that
 * the blob paste is gone (#287). Built as an object rather than encoded and
 * decoded, because there is no longer a codec between the two.
 */
function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    endpoint: "wss://10.0.0.5:7777",
    label: "prod-vm-1",
    caCert: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
    clientCert: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
    clientKey: CLIENT_KEY,
    bearer: BEARER,
    ...overrides,
  };
}

async function count(table: "cores" | "core_secrets"): Promise<number> {
  const { rows } = await testDb.pool.query(`select count(*)::int as n from ${table}`);
  return rows[0]!.n as number;
}
const coreRowCount = () => count("cores");
const secretRowCount = () => count("core_secrets");

beforeEach(async () => {
  await resetPanelState(testDb);
  await createOperator({ name: "Test Operator", password: "test-password" });
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("Core registry", () => {
  it("registers a Core from the credential a pairing produced", async () => {
    const core = (await registerCoreFromCredential(credential()));
    expect(core.endpoint).toBe("wss://10.0.0.5:7777");
    expect(core.label).toBe("prod-vm-1");
    expect(core.lastEventId).toBe(0);
    expect((await listCores()).map((c) => c.id)).toEqual([core.id]);
    expect((await getCore(core.id))?.endpoint).toBe("wss://10.0.0.5:7777");
  });

  it("keeps the secrets available to the dialer", async () => {
    const core = (await registerCoreFromCredential(credential()));
    expect((await getCoreSecrets(core.id))).toEqual({
      caCert: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
      clientCert: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
      clientKey: CLIENT_KEY,
      bearer: BEARER,
    });
  });

  it("stores no readable secret material in the database", async () => {
    (await registerCoreFromCredential(credential()));
    const { rows } = await testDb.pool.query("select sealed from core_secrets");
    expect(rows).toHaveLength(1);
    const blob = Buffer.from(rows[0]!.sealed as Uint8Array).toString("utf8");
    expect(blob).not.toContain(BEARER);
    expect(blob).not.toContain("PRIVATE KEY");
    // Nor anywhere else in the database — the registry row is plaintext by
    // design, but it must not carry the secret half. Every column of every row
    // is searched, as text.
    for (const table of ["cores", "core_secrets", "operator", "panel_sessions"]) {
      const dump = await testDb.pool.query(`select t::text as row from ${table} t`);
      for (const r of dump.rows) {
        expect(r.row as string).not.toContain(BEARER);
        expect(r.row as string).not.toContain("MIIsecret");
      }
    }
  });

  it("falls back to the endpoint host when the credential carries no label", async () => {
    const core = (await registerCoreFromCredential(credential({ label: "" })));
    expect(core.label).toBe("10.0.0.5");
  });

  it("rejects a credential whose secret fields are blank", async () => {
    // Shaped right, useless to dial with. Registering one would take the
    // endpoint and leave a Core that can never connect and can't be paired
    // again without a manual removal.
    for (const blank of ["caCert", "clientCert", "clientKey", "bearer"] as const) {
      await expect(registerCoreFromCredential(credential({ [blank]: "" }))).rejects.toThrow(
        CoreRegistryError,
      );
    }
    expect(await coreRowCount()).toBe(0);
    expect(await secretRowCount()).toBe(0);
  });

  it("rejects a credential that names no endpoint", async () => {
    await expect(registerCoreFromCredential(credential({ endpoint: "  " }))).rejects.toThrow(
      CoreRegistryError,
    );
    expect(await coreRowCount()).toBe(0);
  });

  // This assertion outlived the function it was written against. It used to be
  // "rejects a plaintext ws:// endpoint" on `registerCoreFromRegistrationBlob`,
  // where the codec held the rule; #287 deleted that door, and mTLS being
  // mandatory (ADR 0002) is a property of the registry rather than of any one
  // way into it. So it comes back here, on the door that is left.
  it("rejects a plaintext ws:// endpoint — mTLS is not optional", async () => {
    await expect(registerCoreFromCredential(credential({ endpoint: "ws://10.0.0.5:7777" }))).rejects.toThrow(
      CoreRegistryError,
    );
    expect(await coreRowCount()).toBe(0);
    expect(await secretRowCount()).toBe(0);
  });

  it("rejects anything that is not a URL scheme at all", async () => {
    for (const endpoint of ["10.0.0.5:7777", "https://10.0.0.5:7777", "WSS://10.0.0.5:7777"]) {
      await expect(registerCoreFromCredential(credential({ endpoint }))).rejects.toThrow(CoreRegistryError);
    }
    expect(await coreRowCount()).toBe(0);
  });

  it("refuses a second registration of the same endpoint, leaving the first intact", async () => {
    const first = (await registerCoreFromCredential(credential()));
    await expect(registerCoreFromCredential(credential({ label: "duplicate" }))).rejects.toThrow(
      CoreRegistryError,
    );
    expect((await listCores()).map((c) => c.id)).toEqual([first.id]);
    expect((await getCore(first.id))?.label).toBe("prod-vm-1");
    expect(await secretRowCount()).toBe(1);
  });

  describe("the Panel-owned cursor", () => {
    it("advances and is read back off the registry row", async () => {
      const core = (await registerCoreFromCredential(credential()));
      await advanceCoreCursor(core.id, 42);
      expect((await getCore(core.id))?.lastEventId).toBe(42);
    });

    it("never rewinds", async () => {
      const core = (await registerCoreFromCredential(credential()));
      await advanceCoreCursor(core.id, 42);
      await advanceCoreCursor(core.id, 7);
      expect((await getCore(core.id))?.lastEventId).toBe(42);
    });

    it("ignores nonsense rather than corrupting the replay position", async () => {
      const core = (await registerCoreFromCredential(credential()));
      await advanceCoreCursor(core.id, 42);
      await advanceCoreCursor(core.id, Number.NaN);
      await advanceCoreCursor(core.id, -1);
      expect((await getCore(core.id))?.lastEventId).toBe(42);
    });
  });

  describe("renaming", () => {
    it("takes the operator's alias and bumps updated_at", async () => {
      const core = (await registerCoreFromCredential(credential()));
      // Age the row first: registration and the rename can land in the same
      // millisecond, and a bump asserted against the wall clock would flake.
      await testDb.pool.query("update cores set updated_at = 0 where id = $1", [core.id]);
      const renamed = (await renameCore(core.id, "build-box"));
      expect(renamed?.label).toBe("build-box");
      expect((await getCore(core.id))?.label).toBe("build-box");
      expect(renamed?.updatedAt).toBeGreaterThan(0);
    });

    it("trims and caps at 120 characters, like registration does", async () => {
      const core = (await registerCoreFromCredential(credential()));
      expect((await renameCore(core.id, "  spaced out  "))?.label).toBe("spaced out");
      expect((await renameCore(core.id, "x".repeat(200)))?.label).toBe("x".repeat(120));
    });

    it("falls back to the endpoint host rather than leaving a blank row", async () => {
      const core = (await registerCoreFromCredential(credential()));
      expect((await renameCore(core.id, "   "))?.label).toBe("10.0.0.5");
      expect((await renameCore(core.id, ""))?.label).toBe("10.0.0.5");
    });

    it("touches nothing but the label — endpoint, cursor and secrets are left alone", async () => {
      const core = (await registerCoreFromCredential(credential()));
      await advanceCoreCursor(core.id, 17);
      (await renameCore(core.id, "build-box"));
      const after = (await getCore(core.id));
      expect(after?.endpoint).toBe("wss://10.0.0.5:7777");
      expect(after?.lastEventId).toBe(17);
      expect(after?.createdAt).toBe(core.createdAt);
      expect((await getCoreSecrets(core.id))?.bearer).toBe(BEARER);
    });

    it("reports an unknown id rather than writing a row", async () => {
      expect((await renameCore("core_nope", "build-box"))).toBeNull();
      expect(await coreRowCount()).toBe(0);
    });
  });

  describe("removal", () => {
    it("drops the registry row, the secrets, and the cursor", async () => {
      const core = (await registerCoreFromCredential(credential()));
      await advanceCoreCursor(core.id, 99);
      expect((await removeCore(core.id))).toBe(true);
      expect((await getCore(core.id))).toBeNull();
      expect((await getCoreSecrets(core.id))).toBeNull();
      expect(await coreRowCount()).toBe(0);
      expect(await secretRowCount()).toBe(0);
    });

    it("frees the endpoint for a fresh pairing", async () => {
      const core = (await registerCoreFromCredential(credential()));
      (await removeCore(core.id));
      const again = (await registerCoreFromCredential(credential()));
      expect(again.id).not.toBe(core.id);
      expect(again.lastEventId).toBe(0);
    });

    it("reports an unknown id rather than pretending", async () => {
      expect((await removeCore("core_nope"))).toBe(false);
    });
  });
});
