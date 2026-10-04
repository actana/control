// The pairing lines of `core-entry.ts`, pinned by source order.
//
// `startCore` is not exported and importing the module boots a daemon, so its
// wiring can only be asserted on the source, as `core-boot-refusals.test.ts`
// does for the refusals. Four things matter and none is caught by any other
// suite, because the suites build their own `createPairing`:
//
//   * the store is `corePairingStore`, not the SDK's `jsonFileStore` — the same
//     type, so swapping it type-checks and passes every test while a corrupt
//     `pairing.json` starts reading as "nothing revoked";
//   * the revocation set is seeded by an awaited refresh before the server is
//     built, because the SDK's sweep does not return its own first read;
//   * the pairing routes and the pre-auth predicate are handed to the server
//     before it is built, and the sweep is started after it — every pairing
//     suite builds its own routes, so unmounting them here fails none of them.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const entry = fs.readFileSync(path.resolve(__dirname, "..", "core-entry.ts"), "utf8");
const code = entry
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

describe("the daemon's pairing wiring", () => {
  it("uses the fail-closed store, never the SDK's lenient one", () => {
    expect(code).toContain("store: corePairingStore(pairingStorePath(materialFile))");
    expect(code).not.toMatch(/\bjsonFileStore\b/);
  });

  it("seeds the revocation set, and reports an unreadable store, before it builds the server", () => {
    const seeded = code.indexOf("reportUnreadableRevocations(await pairing.gate.revocations.refresh())");
    expect(seeded).toBeGreaterThan(-1);
    expect(code.indexOf("createPairing({")).toBeLessThan(seeded);
    expect(seeded).toBeLessThan(code.indexOf("new PtyCoreLinkServer("));
  });

  it("hands the server the set the gate owns, and the sweep's callback reports fail-closed", () => {
    expect(code).toContain("serverOpts.revocation = pairing.gate.revocations;");
    expect(code).toContain("onRevoked: revokedHandler(");
  });

  it("mounts the pairing routes and the pre-auth predicate before the server, and starts the sweep after it", () => {
    const server = code.indexOf("new PtyCoreLinkServer(");
    expect(server).toBeGreaterThan(-1);

    const routes = code.indexOf("composeCoreHttpRoutes(auditPairingRoutes(pairing.redeem, ");
    expect(routes).toBeGreaterThan(-1);
    expect(code.indexOf("serverOpts.httpRoutes =")).toBeLessThan(server);
    expect(routes).toBeLessThan(server);

    const preAuth = code.indexOf("serverOpts.isPreAuthPath = pairing.gate.isPreAuthPath");
    expect(preAuth).toBeGreaterThan(-1);
    expect(preAuth).toBeLessThan(server);

    const sweep = code.indexOf("pairing.startRevocationSweep()");
    expect(sweep).toBeGreaterThan(server);
  });
});
