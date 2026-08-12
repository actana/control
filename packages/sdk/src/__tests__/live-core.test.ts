// The Core client against a Core that is actually running (issue 153).
//
// Opt-in, and skipped when it has nothing to dial: set `ACTANA_CORE_BLOB` to a
// registration blob — the base64 paste itself, or a path to the file `actana
// setup` wrote — and this suite drives both entry points against that machine's
// live daemon.
//
//     ACTANA_CORE_BLOB=~/.config/actana/registration-blob.txt \
//       pnpm --filter @actana/sdk test
//
// Why it exists when the rest of the suite already runs the real server class:
// the in-process suites choose the Core's configuration, and this one is handed
// it. A live Core has a real event log with real rows in it, a bearer signed by
// a secret this test does not know, a protocol version this build did not pick,
// and its own answer about the `multiConnection` capability — so it is the only
// place the client's tolerance of a Core it did not configure is exercised.
//
// **Every request here is read-only.** This dials a machine somebody is working
// on: nothing spawns a PTY, writes to a Session, claims a lock or mutates a row.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CoreClient } from "../core-client";
import { DurableCoreClient } from "../durable-core-client";
import { coreConnectionFromBlob, type CoreRegistrationBlob } from "../core-registration-blob";

/**
 * Read the blob out of the environment. A value starting with `/` or `~` is a
 * path; anything else is the paste itself. Base64 decoding lives here rather
 * than in the package because the SDK takes a blob *object* — where a blob is
 * kept, and how it is encoded at rest, is the CLI's business (#129 D9).
 */
function loadBlob(): CoreRegistrationBlob | null {
  const raw = process.env.ACTANA_CORE_BLOB?.trim();
  if (!raw) return null;
  const source = raw.startsWith("~")
    ? readFileSync(raw.replace(/^~/, homedir()), "utf8")
    : raw.startsWith("/")
      ? readFileSync(raw, "utf8")
      : raw;
  const json = Buffer.from(source.trim(), "base64").toString("utf8");
  const parsed = JSON.parse(json) as CoreRegistrationBlob;
  if (!parsed.endpoint || !parsed.bearer) throw new Error("ACTANA_CORE_BLOB is not a blob");
  return parsed;
}

const blob = loadBlob();

describe.skipIf(blob === null)("Core client against a live Core", () => {
  let client: CoreClient | null = null;

  afterEach(() => {
    client?.close();
    client = null;
  });

  it("unpacks the live blob into an endpoint, cert material and a bearer", () => {
    const connection = coreConnectionFromBlob(blob!);
    expect(connection.url).toMatch(/^wss:\/\//);
    expect(connection.httpsBaseUrl).toMatch(/^https:\/\//);
    expect(connection.tls?.ca).toContain("BEGIN CERTIFICATE");
    expect(connection.tls?.cert).toContain("BEGIN CERTIFICATE");
    expect(connection.tls?.key).toMatch(/BEGIN (RSA )?PRIVATE KEY/);
    expect(connection.bearer).toBe(blob!.bearer);
  });

  it("connects, authenticates and answers a read-only request", async () => {
    client = CoreClient.fromRegistrationBlob(blob!, { connectTimeoutMs: 15_000 });
    const info = await client.connect();

    expect(info.coreId).toMatch(/^core_/);
    expect(info.protocolVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(info.bearerExpiresAt).toBeGreaterThan(Date.now());
    expect(client.isAuthenticated()).toBe(true);

    // Read-only, and shaped by whatever that machine happens to hold.
    const projects = await client.projectsList();
    expect(Array.isArray(projects)).toBe(true);
    const sessions = await client.sessionsList();
    expect(Array.isArray(sessions)).toBe(true);
    const availability = await client.agentsAvailabilityList();
    expect(typeof availability).toBe("object");
  }, 30_000);

  it("replays the live event log to a durable client and lands on its cursor", async () => {
    const durable = DurableCoreClient.fromRegistrationBlob(blob!, { connectTimeoutMs: 15_000 });
    client = durable;
    await durable.connect();

    await vi.waitFor(() => expect(durable.isCaughtUp()).toBe(true), { timeout: 20_000 });
    // A live Core's log is not empty, and the cursor is where the replay ended.
    expect(durable.getLastEventId()).toBeGreaterThan(0);
  }, 30_000);
});
