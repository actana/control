// `actana core status` against a Core that is actually running, every run.
//
// `live-core.test.ts` is the same claim against the operator's own Core, and it
// is opt-in by necessity: it needs credentials for a machine only they have.
// That left `core-probe.ts` — the one place this package touches a socket, and
// the module the ticket's "reaches a real Core and reports its version"
// criterion is really about — covered by a suite that a default `pnpm test`
// skips. `core-command.test.ts` injects the probe, which is what makes the
// flags, the output and the exit codes testable without a Core, and it is
// exactly why that suite cannot say whether the probe works.
//
// So this one brings the Core with it. The rig moved to `in-process-core.ts`
// when #160's `session` verbs and #161's `events tail` each needed one too —
// same real `PtyCoreLinkServer`, same real `wss://` port, same mTLS material
// from the Core's own `generateCertMaterial` and a bearer the Core's own
// verifier accepts. Nothing is faked between the CLI and the Core except the
// machine they would otherwise be on.
//
// **This is what `vitest.config.ts`'s `@actana/core` alias is for.** The alias
// was written for exactly this and nothing imported it, so the comment
// justifying it described something that did not happen — which the review of
// #201 noted. `@actana/core` stays out of `package.json` on purpose: it is a
// private package and a daemon, and a manifest entry would put both in the
// published CLI's dependency graph for the sake of a test (ADR 0025 D4). A
// test-only module alias buys the coverage without the graph.

import { describe, it, expect, afterEach } from "vitest";
import { probeCore } from "../core-probe.ts";
import { EXIT_FAILURE, EXIT_OK } from "../exit-codes.ts";
import {
  makeCliFixture,
  registerCore,
  type CliFixture,
} from "./cli-harness.ts";
import { CORE_ID, startInProcessCore, type InProcessCore } from "./in-process-core.ts";

let core: InProcessCore | null = null;
let fixture: CliFixture | null = null;

afterEach(() => {
  core?.close();
  core = null;
  fixture?.cleanup();
  fixture = null;
});

describe("actana core status, against a Core in this process", () => {
  it("registers a Core from a pipe and reports the version it answers with", async () => {
    core = await startInProcessCore();
    fixture = makeCliFixture();

    // The registry a pairing leaves behind — `core add` is gone (#287), and
    // nothing here ever shelled out to fetch a credential.
    registerCore(fixture.paths, "inproc", core.blobText);

    // The real probe. This is the module no other unconditional suite runs.
    const status = await fixture.run(["core", "status", "--json"], { probe: probeCore });
    expect(status.code, status.err.join("\n")).toBe(EXIT_OK);

    const payload = JSON.parse(status.out.join("\n"));
    expect(payload.reachable).toBe(true);
    expect(payload.endpoint).toBe(core.endpoint);
    expect(payload.coreId).toBe(CORE_ID);
    // "reports its version": the core-link protocol version off `ready`, which
    // is the only version a Core puts on the wire.
    expect(payload.protocolVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(payload.compatible).toBe(true);
    expect(payload.bearerExpiresAt).toBeGreaterThan(Date.now());
  }, 30_000);

  it("prints the same facts in the human table", async () => {
    core = await startInProcessCore();
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const status = await fixture.run(["core", "status", "--verbose"], { probe: probeCore });
    expect(status.code, status.err.join("\n")).toBe(EXIT_OK);
    expect(status.out.join("\n")).toMatch(/Protocol\s+\d+\.\d+\.\d+/);
    expect(status.out.join("\n")).toContain(CORE_ID);
    expect(status.err.join("\n")).toContain("resolved the Core from");
  }, 30_000);

  it("never prints the credential it just dialled with, even with --verbose", async () => {
    // The sweep in `never-logs-a-blob.test.ts` runs against sentinel strings.
    // This runs it against *real* PEM material and a *real* signed bearer, on
    // the one path that has a live socket and a Core's answers to quote.
    core = await startInProcessCore();
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const decoded = JSON.parse(Buffer.from(core.blobText, "base64").toString("utf8")) as {
      caCert: string;
      clientCert: string;
      clientKey: string;
      bearer: string;
    };

    for (const argv of [
      ["core", "status", "--verbose"],
      ["core", "status", "--json", "--verbose"],
      ["core", "ls", "--verbose"],
    ]) {
      const run = await fixture.run(argv, { probe: probeCore });
      for (const secret of [decoded.caCert, decoded.clientCert, decoded.clientKey, decoded.bearer]) {
        // Whole PEMs are unwieldy in a haystack; a 40-character run of one is
        // as much of a leak as all of it, and catches a truncated echo too.
        for (const chunk of [secret.slice(0, 40), secret.slice(-40)]) {
          expect(run.all, `${argv.join(" ")} printed a credential`).not.toContain(chunk);
        }
      }
      // The sweep cannot pass by printing nothing.
      expect(run.all).toContain("wss://127.0.0.1:");
    }
  }, 30_000);

  it("exits non-zero against a Core speaking a protocol it does not, rather than degrading", async () => {
    // The gate that matters most on a real fleet: a Core on a different train.
    // `protocolVersion` exists on the server options for exactly this — a real
    // drifted Core is a different build entirely.
    core = await startInProcessCore({ protocolVersion: "999.0.0" });
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const status = await fixture.run(["core", "status", "--json"], { probe: probeCore });
    expect(status.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(status.out.join("\n"));
    expect(payload.reachable).toBe(true);
    expect(payload.protocolVersion).toBe("999.0.0");
    expect(payload.compatible).toBe(false);
  }, 30_000);

  it("reports a Core that is not there as unreachable, not as a bad blob", async () => {
    // The control that makes the tests above mean something: the same CLI, the
    // same real probe, aimed at a port with nothing behind it. Without it,
    // every assertion here would pass against a suite that never started a Core.
    core = await startInProcessCore();
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);
    core.close();
    core = null;

    const status = await fixture.run(["core", "status", "--json"], { probe: probeCore });
    expect(status.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(status.out.join("\n"));
    expect(payload.reachable).toBe(false);
    expect(payload.error).toBeTruthy();
  }, 30_000);
});
