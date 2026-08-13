// The wiring `core-entry` uses to mount the `/v1/…` file routes (#165 F9).
//
// This suite exists because of a defect that every other file suite was
// structurally incapable of catching. `core-files-mtls.test.ts` stands up a
// real `PtyCoreLinkServer`, but it hand-wires the routes with a *working*
// bearer verifier — so it proved the routes work when wired correctly and said
// nothing about whether `core-entry` wires them correctly. It did not:
//
//   - `core-entry` always passed an `authVerifier`, a closure reaching for
//     `serverOpts.authVerifier` and answering `{ ok: false, reason: "malformed" }`
//     when there was none;
//   - `serverOpts.authVerifier` is only ever assigned in remote mode;
//   - so on the **default loopback Core** every `/v1` request was refused 401,
//     while `announceFiles` — defaulting to "yes if routes are mounted" — put
//     `files: { version: 1 }` on the `ready` frame anyway.
//
// A Core that says it has a file surface and then refuses every request to it
// is the exact failure ADR 0028 D4 names: a client that reads the capability
// stops feature-detecting and starts calling. #166 and #168 consume
// `canUseFileRoutes()`, so every local Core would have inherited it.
//
// So the invariant is tested rather than the implementation: **if a Core
// announces the capability, an otherwise-valid request to its routes is
// answered.** The last test in this file is that sentence.
import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreFilesPort, CoreHttpRoutes, FilesAuthVerifier } from "../core-files-routes";
import { buildCoreFileRoutes, shouldAnnounceFiles } from "../core-files-wiring";
import { cleanupTrees, makeTree } from "./files-fixture";

let servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  cleanupTrees();
});

/** A verifier that accepts exactly one bearer, the way a paired remote Core's does. */
const acceptsOnly =
  (good: string): FilesAuthVerifier =>
  (bearer) =>
    bearer === good ? { ok: true, coreId: "core_test", exp: 2 ** 40 } : { ok: false, reason: "bad-signature" };

/** Mount a wiring on a real listener and return its base URL. */
async function serve(routes: CoreHttpRoutes): Promise<string> {
  const server = http.createServer();
  servers.push(server);
  server.on("request", (req, res) => {
    if (routes.handle(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

function get(base: string, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${url}`, { method: "GET", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A Project holding one readable file, so an authorised request has something to answer with. */
function oneProject(): CoreFilesPort {
  const root = makeTree({ "notes.txt": "hello from a Project" });
  return { projectRoot: (id) => (id === "p1" ? root : null) };
}

describe("the loopback Core — no bearer verifier", () => {
  it("answers its /v1 routes rather than refusing them 401", async () => {
    // The wiring `core-entry` reaches when `serverOpts.authVerifier` is unset,
    // which is every non-remote Core. Before the fix this was a closure that
    // was always present and always said no, and this request was a 401.
    const routes = buildCoreFileRoutes({ filesPort: oneProject() });
    const base = await serve(routes);

    const answered = await get(base, "/v1/projects/p1/files?path=notes.txt");

    expect(answered.status).toBe(200);
    expect(answered.body).toBe("hello from a Project");
  });

  it("makes the documented `authVerifier` omitted case reachable at all", async () => {
    // `CoreFilesRoutesOptions.authVerifier` documents "when omitted — the
    // loopback `ws://` Core, and tests — the surface is as trusted as the rest
    // of that Core". That sentence described a state production could not
    // produce. It can now, and this is the test that says so: a bearer that
    // would fail any verifier is simply not looked at.
    const routes = buildCoreFileRoutes({ filesPort: oneProject() });
    const base = await serve(routes);

    const withNonsense = await get(base, "/v1/projects/p1/files?path=notes.txt", {
      authorization: "Bearer not-a-real-bearer",
    });

    expect(withNonsense.status).toBe(200);
  });

  it("still announces the capability, because its routes answer", () => {
    const routes = buildCoreFileRoutes({ filesPort: oneProject() });
    // ADR 0028's consequence — "the loopback `ws://` Core gets the routes too,
    // over plain HTTP" — is now true rather than contradicted.
    expect(shouldAnnounceFiles(routes)).toBe(true);
  });
});

describe("the remote Core — a real bearer verifier", () => {
  it("requires the bearer the core link requires", async () => {
    const routes = buildCoreFileRoutes({ filesPort: oneProject(), authVerifier: acceptsOnly("good-bearer") });
    const base = await serve(routes);

    const none = await get(base, "/v1/projects/p1/files?path=notes.txt");
    const wrong = await get(base, "/v1/projects/p1/files?path=notes.txt", { authorization: "Bearer wrong" });
    const right = await get(base, "/v1/projects/p1/files?path=notes.txt", { authorization: "Bearer good-bearer" });

    expect(none.status).toBe(401);
    expect(JSON.parse(none.body).code).toBe("unauthorized");
    expect(wrong.status).toBe(401);
    expect(right.status).toBe(200);
    expect(right.body).toBe("hello from a Project");
  });

  it("announces the capability too — the gate is on who may call, not on whether it answers", () => {
    const routes = buildCoreFileRoutes({ filesPort: oneProject(), authVerifier: acceptsOnly("good-bearer") });
    expect(shouldAnnounceFiles(routes)).toBe(true);
  });
});

describe("ADR 0028 D4, as an executable sentence", () => {
  // "Announcing a capability whose routes are not answering is worse than
  // announcing nothing." Both wirings a Core can have, one assertion.
  it.each([
    ["loopback (no verifier)", undefined, {}],
    ["remote (verifier)", acceptsOnly("good-bearer"), { authorization: "Bearer good-bearer" }],
  ] as const)("a Core announcing `files` answers an authorised request — %s", async (_label, verifier, headers) => {
    const routes = buildCoreFileRoutes({
      filesPort: oneProject(),
      ...(verifier ? { authVerifier: verifier } : {}),
    });

    // The two halves that disagreed. If the capability is announced, the routes
    // must answer; if they cannot, the announcement must not be made.
    expect(shouldAnnounceFiles(routes)).toBe(true);

    const base = await serve(routes);
    const answered = await get(base, "/v1/projects/p1/files?path=notes.txt", { ...headers });

    expect(answered.status).toBe(200);
    expect(answered.status).not.toBe(401);
  });
});
