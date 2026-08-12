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
// So this one brings the Core with it: `packages/core`'s real
// `PtyCoreLinkServer`, on a real `wss://` port, with mTLS material from the
// Core's own `generateCertMaterial` and a bearer the Core's own verifier
// accepts. The blob is assembled from that material, registered through `core
// add`, and read back through the real `probeCore`. Nothing is faked between
// the CLI and the Core except the machine they would otherwise be on.
//
// **This is what `vitest.config.ts`'s `@actana/core` alias is for.** The alias
// was written for exactly this and nothing imported it, so the comment
// justifying it described something that did not happen — which the review of
// #201 noted. `@actana/core` stays out of `package.json` on purpose: it is a
// private package and a daemon, and a manifest entry would put both in the
// published CLI's dependency graph for the sake of a test (ADR 0025 D4).
// A test-only module alias buys the coverage without the graph.

import { describe, it, expect, afterEach } from "vitest";
import { Server } from "node:net";
import https from "node:https";
import { WebSocketServer } from "ws";
import {
  PtyCoreLinkServer,
  type WebSocketLike as ServerSocketLike,
  type WebSocketServerLike,
} from "@actana/core/pty-core-link-server";
import { generateCertMaterial } from "@actana/core/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { probeCore } from "../core-probe.ts";
import { EXIT_FAILURE, EXIT_OK } from "../exit-codes.ts";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";

const SECRET = "cli-in-process-core-secret-at-least-32-bytes";
const CORE_ID = "core_in_process";

/**
 * A PTY manager that is never asked for anything.
 *
 * `core status` sends no request frames at all — it reads the `ready` and
 * `authOk` frames the Core opens every connection with, and hangs up — so every
 * method here is unreachable by design rather than by stubbing. They throw
 * rather than returning empties: if a later change to the probe starts spawning
 * something, this suite should fail loudly instead of quietly proving less.
 */
function unusedPtyCore(): never[] & Record<string, unknown> {
  const unreachable = (name: string) => () => {
    throw new Error(`core status reached the PTY manager (${name}) — it is meant to be read-only`);
  };
  return {
    setEmitTarget: () => {},
    spawn: unreachable("spawn"),
    write: unreachable("write"),
    resize: unreachable("resize"),
    kill: unreachable("kill"),
    killAll: unreachable("killAll"),
    killLaunchProcesses: unreachable("killLaunchProcesses"),
    killPtysUnderPath: unreachable("killPtysUnderPath"),
    findByTask: unreachable("findByTask"),
    taskIdForPty: () => null,
    replay: unreachable("replay"),
  } as unknown as never[] & Record<string, unknown>;
}

/** A free TCP port on 127.0.0.1, found by briefly binding port 0. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = new Server();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        s.close(() => resolve(port));
      } else {
        s.close();
        reject(new Error("no port"));
      }
    });
  });
}

/**
 * The real `wss://` server the Core builds, with the bound port recorded.
 * `requestCert` plus `rejectUnauthorized` are what make this a mutual
 * handshake — without them the blob's client cert would be decoration.
 */
function recordingCreateServer(
  bound: { port: number },
): (opts: { port: number; host: string; tls?: unknown }) => WebSocketServerLike {
  return (opts) => {
    const tls = opts.tls as { caCert: string; serverCert: string; serverKey: string };
    const tlsServer = https.createServer({
      cert: tls.serverCert,
      key: tls.serverKey,
      ca: tls.caCert,
      requestCert: true,
      rejectUnauthorized: true,
    });
    tlsServer.listen(opts.port, opts.host, () => {
      const addr = tlsServer.address();
      if (addr && typeof addr === "object") bound.port = addr.port;
    });
    const wss = new WebSocketServer({ server: tlsServer });
    return {
      close: (cb?: () => void) => wss.close(() => tlsServer.close(cb)),
      on: (event: string, cb: unknown) => {
        if (event === "connection") {
          wss.on("connection", (ws) => (cb as (s: ServerSocketLike) => void)(adapt(ws)));
        } else if (event === "error") {
          wss.on("error", (err: Error) => (cb as (e: Error) => void)(err));
        }
      },
    } as WebSocketServerLike;
  };
}

function adapt(ws: import("ws").WebSocket): ServerSocketLike {
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    on: (event: string, cb: unknown) => {
      if (event === "message") ws.on("message", (d: unknown) => (cb as (d: unknown) => void)(d));
      else if (event === "close") ws.on("close", () => (cb as () => void)());
      else if (event === "error") ws.on("error", (e: Error) => (cb as (e: Error) => void)(e));
    },
    removeAllListeners: () => ws.removeAllListeners(),
  } as ServerSocketLike;
}

let server: PtyCoreLinkServer | null = null;
let fixture: CliFixture | null = null;

afterEach(() => {
  server?.close();
  server = null;
  fixture?.cleanup();
  fixture = null;
});

/** A Core on a real port, and the base64 blob an operator would be handed for it. */
async function startCore(
  opts: { protocolVersion?: string; bearerExpiresInMs?: number } = {},
): Promise<{ blobText: string; endpoint: string }> {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const port = await freePort();
  const bound = { port: 0 };
  server = new PtyCoreLinkServer(unusedPtyCore() as never, {
    port,
    host: "127.0.0.1",
    createServer: recordingCreateServer(bound),
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier: (bearer: string) => verifyBearer(bearer, SECRET),
    ...(opts.protocolVersion === undefined ? {} : { protocolVersion: opts.protocolVersion }),
  });

  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const tick = () => {
      if (bound.port > 0) return resolve();
      if (Date.now() > deadline) return reject(new Error("TLS server never bound"));
      setTimeout(tick, 10);
    };
    tick();
  });

  const endpoint = `wss://127.0.0.1:${bound.port}`;
  const blobText = Buffer.from(
    JSON.stringify({
      endpoint,
      label: "in-process",
      caCert: material.ca.cert,
      clientCert: material.client.cert,
      clientKey: material.client.key,
      bearer: signBearer(
        { coreId: CORE_ID, exp: Date.now() + (opts.bearerExpiresInMs ?? 3_600_000) },
        SECRET,
      ),
    }),
    "utf8",
  ).toString("base64");

  return { blobText, endpoint };
}

describe("actana core status, against a Core in this process", () => {
  it("registers a Core from a pipe and reports the version it answers with", async () => {
    const { blobText, endpoint } = await startCore();
    fixture = makeCliFixture();

    // `core add` from stdin — the path the ticket names, and never a shell-out.
    const added = await fixture.run(["core", "add", "inproc"], { stdin: blobText });
    expect(added.code, added.err.join("\n")).toBe(EXIT_OK);

    // The real probe. This is the module no other unconditional suite runs.
    const status = await fixture.run(["core", "status", "--json"], { probe: probeCore });
    expect(status.code, status.err.join("\n")).toBe(EXIT_OK);

    const payload = JSON.parse(status.out.join("\n"));
    expect(payload.reachable).toBe(true);
    expect(payload.endpoint).toBe(endpoint);
    expect(payload.coreId).toBe(CORE_ID);
    // "reports its version": the core-link protocol version off `ready`, which
    // is the only version a Core puts on the wire.
    expect(payload.protocolVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(payload.compatible).toBe(true);
    expect(payload.bearerExpiresAt).toBeGreaterThan(Date.now());
  }, 30_000);

  it("prints the same facts in the human table", async () => {
    const { blobText } = await startCore();
    fixture = makeCliFixture();
    await fixture.run(["core", "add", "inproc"], { stdin: blobText });

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
    const { blobText } = await startCore();
    fixture = makeCliFixture();
    await fixture.run(["core", "add", "inproc"], { stdin: blobText });

    const decoded = JSON.parse(Buffer.from(blobText, "base64").toString("utf8")) as {
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
    const { blobText } = await startCore({ protocolVersion: "999.0.0" });
    fixture = makeCliFixture();
    await fixture.run(["core", "add", "inproc"], { stdin: blobText });

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
    const { blobText } = await startCore();
    fixture = makeCliFixture();
    await fixture.run(["core", "add", "inproc"], { stdin: blobText });
    server?.close();
    server = null;

    const status = await fixture.run(["core", "status", "--json"], { probe: probeCore });
    expect(status.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(status.out.join("\n"));
    expect(payload.reachable).toBe(false);
    expect(payload.error).toBeTruthy();
  }, 30_000);
});
