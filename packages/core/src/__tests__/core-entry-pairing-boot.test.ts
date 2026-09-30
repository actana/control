// The pairing lines of `core-entry.ts`, pinned by source order.
//
// `startCore` is not exported and importing the module boots a daemon, so its
// wiring can only be asserted on the source, as `core-boot-refusals.test.ts`
// does for the refusals. Two lines matter and neither is caught by any other
// suite, because the suites build their own `createPairing`:
//
//   * the store is `corePairingStore`, not the SDK's `jsonFileStore` — the same
//     type, so swapping it type-checks and passes every test while a corrupt
//     `pairing.json` starts reading as "nothing revoked";
//   * the revocation set is seeded by an awaited refresh before the server is
//     built, because the SDK's sweep does not return its own first read.
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
});
