// `actana core status` against a Core that is actually running (#157).
//
// Opt-in, and skipped when it has nothing to dial: set `ACTANA_CORE_BLOB` to a
// registration blob — the base64 paste itself, or a path to the file `actana
// setup` wrote — and this suite registers that Core in a throwaway registry and
// asks it what version it speaks.
//
//     ACTANA_CORE_BLOB=~/.config/actana/registration-blob.txt \
//       pnpm --filter @actana/cli test
//
// Why it exists when `core-command.test.ts` already covers the verb: that suite
// injects the probe, which is what makes the flags, the output and the exit
// codes testable without a Core — and it means the one thing it cannot prove is
// that the probe works. This is the ticket's "reaches a real Core and reports
// its version", and the real `probeCore` is what it runs.
//
// **Every request here is read-only.** `core status` sends no request frames at
// all: it reads the `ready` and `authOk` frames a Core opens every connection
// with, and hangs up. Nothing spawns a PTY, writes to a Session or claims a
// lock on a machine somebody may be working on.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { probeCore } from "../core-probe.ts";
import { EXIT_OK } from "../exit-codes.ts";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";

/**
 * The blob text out of the environment: a paste, or a path to one. The same
 * two shapes `ACTANA_CORE_BLOB` takes in the CLI itself, read here directly
 * rather than through the CLI so that a failure in this suite points at the
 * Core rather than at the resolution order `core-resolution.test.ts` covers.
 */
function liveBlobText(): string | null {
  const raw = process.env.ACTANA_CORE_BLOB?.trim();
  if (!raw) return null;
  if (raw.startsWith("~")) return readFileSync(raw.replace(/^~/, homedir()), "utf8");
  if (raw.startsWith("/")) return readFileSync(raw, "utf8");
  return raw;
}

const blobText = liveBlobText();

let fixture: CliFixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describe.skipIf(blobText === null)("actana core, against a live Core", () => {
  it("registers the Core from stdin and reports the version it answers with", async () => {
    fixture = makeCliFixture();

    // `core add` from a pipe — the path the ticket names, and never a shell-out.
    const added = await fixture.run(["core", "add", "live"], { stdin: blobText! });
    expect(added.code).toBe(EXIT_OK);

    const status = await fixture.run(["core", "status", "--json", "--core", "live"], {
      probe: probeCore,
    });
    expect(status.code, status.err.join("\n")).toBe(EXIT_OK);

    const payload = JSON.parse(status.out.join("\n"));
    expect(payload.reachable).toBe(true);
    expect(payload.endpoint).toMatch(/^wss:\/\//);
    expect(payload.coreId).toMatch(/^core_/);
    // The version this Core reports over the link, and the point of the suite.
    expect(payload.protocolVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(payload.compatible).toBe(true);
    expect(payload.bearerExpiresAt).toBeGreaterThan(Date.now());
  });

  it("prints the same facts in the human table, and no credential in either", async () => {
    fixture = makeCliFixture();
    await fixture.run(["core", "add", "live"], { stdin: blobText! });

    const status = await fixture.run(["core", "status", "--verbose"], { probe: probeCore });
    expect(status.code, status.err.join("\n")).toBe(EXIT_OK);
    expect(status.out.join("\n")).toMatch(/Protocol\s+\d+\.\d+\.\d+/);
    expect(status.out.join("\n")).toMatch(/Core id\s+core_/);

    // The live blob's own secrets, swept out of everything either stream said.
    const blob = JSON.parse(Buffer.from(blobText!.trim(), "base64").toString("utf8"));
    for (const field of ["caCert", "clientCert", "clientKey", "bearer"] as const) {
      const secret = String(blob[field]);
      expect(status.all, `core status printed ${field}`).not.toContain(secret);
      // And no long fragment of one either.
      expect(status.all).not.toContain(secret.slice(0, 60));
    }
  });

  it("fails honestly against an endpoint with no Core behind it", async () => {
    fixture = makeCliFixture();
    const blob = JSON.parse(Buffer.from(blobText!.trim(), "base64").toString("utf8"));
    // The same credential, pointed at a port nothing listens on. Port 1 is
    // privileged and unbound on every machine this runs on.
    const unreachable = Buffer.from(
      JSON.stringify({ ...blob, endpoint: "wss://127.0.0.1:1" }),
    ).toString("base64");

    await fixture.run(["core", "add", "dead"], { stdin: unreachable });
    const status = await fixture.run(["core", "status", "--json", "--core", "dead"], {
      probe: probeCore,
    });

    expect(status.code).not.toBe(EXIT_OK);
    expect(JSON.parse(status.out.join("\n")).reachable).toBe(false);
  });
});
