// The SDK's first HTTPS surface, over a real mutual TLS handshake (#167).
//
// Everything this package did before `project.files.*` was a WebSocket, and
// `core-link-mtls.test.ts` proves that leg. This is the other one, and it is
// not the same claim: **`fetch` is undici, and it ignores `options.cert` and
// `options.key` outright.** A client certificate reaches it only through a
// dispatcher. The phase-1 spike (#151, PR 189) froze that shape and confirmed
// D12 — both legs pass on Node 22 — and what this suite does is hold the
// shipped code to the frozen finding rather than rediscover it:
//
//     const agent = new Agent({ connect: { ca, cert, key } });
//     await fetch(url, { dispatcher: agent });
//
// The spike's leg 2b is reproduced here for the same reason it existed there:
// a CA-only dispatcher must be **refused**. Without that control, a passing
// positive test is indistinguishable from a server that never asked for a
// certificate at all.
//
// It also closes the one gap the spike recorded and could not close: it had to
// get its HTTP response from a throwaway loopback listener, because "a real
// Core HTTP route does not exist yet and someone has to add it". PR 215 added
// them, so this runs against the Core's own route handler.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { generateCertMaterial } from "@actana/core/core-cert-material";
import { createCoreFilesRequestHandler } from "@actana/core/core-files-routes";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { CoreClient } from "../core-client";
import { createCoreFilesFetch } from "../core-files-http";
import type { CoreRegistrationBlob } from "../core-registration-blob";
import { collect } from "./files-rig";
import { startCoreRig, type CoreRig } from "./fake-core-link";

const SECRET = "files-mtls-suite-secret-32-bytes-xx";
const PROJECT = "proj_mtls";

/**
 * A TLS-layer refusal as it reaches a caller. Node words it differently across
 * OpenSSL builds, and undici wraps it again, hence the alternation.
 *
 * What is *not* in it matters as much: no `ECONNREFUSED`, which is how a Core
 * that is not running reports itself and would make the control pass against
 * nothing at all.
 */
const TLS_REFUSAL = /ECONNRESET|EPIPE|socket hang up|ERR_SSL|SSL routines|alert|handshake|other side closed/i;

let server: https.Server | null = null;
let client: CoreClient | null = null;
let coreRig: CoreRig | null = null;
let root: string | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  coreRig?.close();
  coreRig = null;
  const running = server;
  server = null;
  if (running) {
    running.closeAllConnections();
    await new Promise<void>((resolve) => running.close(() => resolve()));
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

/**
 * A real mTLS server with the Core's file routes on it, and the registration
 * blob a client would be handed for it.
 *
 * `requestCert` plus `rejectUnauthorized` are what make this a *mutual*
 * handshake and therefore what makes the control below meaningful — they are
 * the same two options the Core's own server factory sets.
 */
async function startCore(): Promise<{ blob: CoreRegistrationBlob; caCert: string; port: number }> {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "actana-sdk-mtls-")));
  fs.writeFileSync(path.join(root, "notes.txt"), "over mutual TLS");

  const projectRoot = root;
  const routes = createCoreFilesRequestHandler({
    filesPort: { projectRoot: (id) => (id === PROJECT ? projectRoot : null) },
    authVerifier: (bearer) => verifyBearer(bearer, SECRET),
  });
  server = https.createServer(
    {
      ca: material.ca.cert,
      cert: material.server.cert,
      key: material.server.key,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      if (routes.handle(req, res)) return;
      res.writeHead(404).end();
    },
  );
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");

  return {
    caCert: material.ca.cert,
    port: address.port,
    blob: {
      endpoint: `wss://127.0.0.1:${address.port}`,
      label: "test-core",
      caCert: material.ca.cert,
      clientCert: material.client.cert,
      clientKey: material.client.key,
      bearer: signBearer({ coreId: "core_mtls", exp: Date.now() + 60_000 }, SECRET),
    },
  };
}

/**
 * A client built from that blob. The socket is the in-memory rig — the `wss://`
 * leg has its own suite and re-proving it here would only slow this one down —
 * while the **file surface is real**: the blob's PEM material, the SDK's own
 * dispatcher, and a genuine handshake against the server above.
 */
async function clientFrom(blob: CoreRegistrationBlob): Promise<CoreClient> {
  coreRig = startCoreRig({
    announceFiles: true,
    // The blob carries a real signed bearer, so the rig has to be the kind of
    // Core that checks one — a rig with no verifier refuses it as malformed.
    authVerifier: (bearer) => verifyBearer(bearer, SECRET),
  });
  client = new CoreClient({ blob, createSocket: coreRig.dialer().createSocket });
  await client.connect();
  return client;
}

describe("the file surface over mutual TLS", () => {
  it("downloads through a client certificate taken from a registration blob", async () => {
    const { blob } = await startCore();
    const core = await clientFrom(blob);

    // `httpsBaseUrl` is derived from the blob's `wss://` endpoint by the client
    // itself — one origin, one certificate, two protocols (ADR 0028).
    expect(core.httpsBaseUrl).toBe(`https://127.0.0.1:${new URL(blob.endpoint).port}`);

    const file = await core.project(PROJECT).files.download({ path: "notes.txt" });

    expect((await collect(file.stream)).toString("utf8")).toBe("over mutual TLS");
  });

  it("uploads through it too, and the bytes land on disk", async () => {
    const { blob } = await startCore();
    const core = await clientFrom(blob);

    const lines = [];
    for await (const line of core.project(PROJECT).files.upload({
      path: "written.txt",
      body: (async function* () {
        yield new TextEncoder().encode("uploaded over mTLS");
      })(),
    })) {
      lines.push(line);
    }

    expect(lines[0]).toMatchObject({ type: "entry", path: "written.txt", result: "written" });
    expect(fs.readFileSync(path.join(root!, "written.txt"), "utf8")).toBe("uploaded over mTLS");
  });

  it("is refused without a client certificate — the control that makes the rest mean anything", async () => {
    const { caCert, port } = await startCore();

    // The spike's leg 2b, verbatim: CA only, no client certificate. Everything
    // else about the request is correct, so the only reason this can fail is
    // the one under test.
    const caOnly = new Agent({ connect: { ca: caCert } });
    const attempt = undiciFetch(
      `https://127.0.0.1:${port}/v1/projects/${PROJECT}/files?path=notes.txt`,
      { dispatcher: caOnly },
    );

    await expect(attempt).rejects.toThrow();
    const error = (await attempt.catch((err: unknown) => err)) as Error;
    const described = `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`;
    expect(described).toMatch(TLS_REFUSAL);
    await caOnly.close();
  });

  it("uses undici's own `fetch`, because the global one rejects this dispatcher outright", async () => {
    // The skew this branch discovered, pinned so it cannot silently reverse.
    // Node embeds its own copy of undici for the global `fetch`, and a
    // `Dispatcher` only satisfies the implementation it came from — undici 8
    // changed the handler interface the embedded copy still expects. A future
    // edit that "simplified" `createCoreFilesFetch` back to the global `fetch`
    // would fail every mTLS call at runtime with an error naming none of this,
    // and would pass any test that only exercised plain `http://`.
    const { blob, port } = await startCore();
    const agent = new Agent({
      connect: { ca: blob.caCert, cert: blob.clientCert, key: blob.clientKey },
    });
    const url = `https://127.0.0.1:${port}/v1/projects/${PROJECT}/files?path=notes.txt`;
    const headers = { authorization: `Bearer ${blob.bearer}` };

    // The same certificate, the same Core, the same dispatcher — and only the
    // matching `fetch` gets through.
    const viaGlobal = await fetch(url, { headers, dispatcher: agent } as RequestInit).catch(
      (err: unknown) => err as Error,
    );
    expect(viaGlobal).toBeInstanceOf(Error);
    expect(String((viaGlobal as { cause?: unknown }).cause ?? "")).toContain("InvalidArgumentError");

    const viaUndici = await undiciFetch(url, { headers, dispatcher: agent });
    expect(viaUndici.status).toBe(200);
    await viaUndici.body?.cancel();
    await agent.close();
  });

  it("is refused with a certificate but no bearer — mTLS is not the gate on its own", async () => {
    const { blob } = await startCore();
    // The certificate says a client talked to this Core once; the bearer says
    // the pairing is still current and has not been revoked by a reissue. The
    // Core wants both, and a client that presented only the first would be
    // relying on a guarantee nobody made.
    const send = createCoreFilesFetch({ ca: blob.caCert, cert: blob.clientCert, key: blob.clientKey });

    const res = await send({
      method: "GET",
      url: `${new URL(blob.endpoint.replace("wss://", "https://")).origin}/v1/projects/${PROJECT}/files?path=notes.txt`,
      headers: {},
    });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized");
  });

  it("reuses one dispatcher across every Project handle a client hands out", async () => {
    const { blob } = await startCore();
    const core = await clientFrom(blob);

    // Two handles, two requests, one connection pool. A dispatcher per handle
    // would mean a fresh TLS handshake for every `client.project(id)` — which a
    // loop over a fleet's Projects does once per iteration.
    const first = await core.project(PROJECT).files.download({ path: "notes.txt" });
    const second = await core.project(PROJECT).files.download({ path: "notes.txt" });
    await collect(first.stream);
    await collect(second.stream);

    expect(fs.existsSync(path.join(root!, "notes.txt"))).toBe(true);
  });
});
