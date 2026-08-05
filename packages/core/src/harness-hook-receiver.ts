// The Core's own hook receiver — where a harness running on this machine
// reports what it is doing.
//
// Three decisions this file makes, recorded because the ticket left them open
// (issue 84):
//
// (a) **Transport: loopback HTTP, not a unix socket.** Every vendor's hook
//     config takes a shell command and every vendor's documentation assumes
//     `curl`; a unix socket would work but costs a `--unix-socket` flag that
//     not every harness's shell has, on every hook, forever. The exposure a
//     socket would have saved is bounded instead by (b) and by binding
//     `127.0.0.1` only — never the Core's public host, and never a route on
//     the core-link listener, which in remote mode demands a Panel client
//     certificate at handshake that a hook subprocess cannot present.
//
// (b) **The token is the Core's, minted per boot.** The retired design passed
//     a bearer down from the Panel; there is no Panel in this hop any more, so
//     the Core mints 32 random bytes at start and holds them in memory. It is
//     never persisted and never leaves this machine: the spawn path puts it in
//     the PTY's environment, and the hook command reads it from there rather
//     than carrying it in a file the operator might commit. A restart mints a
//     fresh one and re-spawns pick it up; a hook from a PTY of the previous
//     boot fails auth, which is correct — that Session's process is gone.
//
// (c) **The port is ephemeral (`0`), never a fixed one.** Asking the OS avoids
//     both a collision with the core-link port — which the Core already treats
//     as protected against its own port-kill path — and a guessable target.
//     The chosen port is published to `getProtectedPorts` for the same reason
//     the core-link port is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import log from "./log";
import { LOCAL_HOOK_API_HOST } from "./pty-hook-env";
import type { HarnessHookBody } from "@actana/shared/harness-hook-pipeline";

/** Largest hook body we will read. A Claude payload is kilobytes; this is slack. */
const MAX_BODY_BYTES = 1_000_000;

const HOOK_PATH_PREFIX = "/api/hooks/";

export type HookReceiverHandler = (
  taskId: string,
  payload: HarnessHookBody,
  /**
   * The event named in the URL, for a payload whose body omits
   * `hook_event_name`. The body still wins when it has one.
   */
  eventNameFallback: string,
) => { ok: boolean; body: Record<string, unknown> };

/**
 * A running loopback hook receiver. `url` and `token` are what the spawn path
 * hands to a PTY; `port` is what the port-kill path must not touch.
 */
export type HarnessHookReceiver = {
  readonly url: string;
  readonly token: string;
  readonly port: number;
  close(): void;
};

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  // Length is not secret (it is a constant of this build), but timingSafeEqual
  // throws on a mismatch, so check it first.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * Read the request body, distinguishing the two ways it can fail. An operator
 * debugging a flaky hook with `curl -v` must not be told their kilobyte
 * payload was "too large" because the socket dropped.
 */
type BodyResult =
  | { ok: true; raw: string }
  | { ok: false; reason: "too-large" | "read-failed" };

function readBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop accumulating, but do NOT destroy the request here: tearing the
        // socket down before the response is written means the caller sees a
        // dropped connection instead of the 413 explaining why. The caller
        // answers first and closes after (see the `too-large` branch below).
        chunks.length = 0;
        resolve({ ok: false, reason: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ ok: true, raw: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => resolve({ ok: false, reason: "read-failed" }));
  });
}

/**
 * Start the receiver on an ephemeral loopback port. Resolves once it is
 * listening, so the spawn path can never hand a PTY a URL nothing answers on.
 *
 * `handler` is called with the task id from the query string and the parsed
 * body; everything it decides (and every write it makes) is its business —
 * this module is the transport and the gate, nothing more.
 */
export async function startHarnessHookReceiver(
  handler: HookReceiverHandler,
): Promise<HarnessHookReceiver> {
  const token = randomBytes(32).toString("hex");

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${LOCAL_HOOK_API_HOST}`);
      if (req.method !== "POST" || !url.pathname.startsWith(HOOK_PATH_PREFIX)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (!bearerMatches(req.headers.authorization, token)) {
        unauthorized(res);
        return;
      }
      const taskId = url.searchParams.get("taskId");
      if (!taskId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "taskId required" }));
        return;
      }
      const body = await readBody(req);
      if (!body.ok) {
        const tooLarge = body.reason === "too-large";
        res.writeHead(tooLarge ? 413 : 400, {
          "content-type": "application/json",
          // The rest of an over-cap body is still in flight and we are not
          // going to read it, so say the connection ends with this answer.
          ...(tooLarge ? { connection: "close" } : {}),
        });
        res.end(
          JSON.stringify({ error: tooLarge ? "payload too large" : "could not read body" }),
          // Only once the answer is flushed is it safe to hang up on the
          // sender still writing at us.
          () => {
            if (tooLarge) req.destroy();
          },
        );
        return;
      }
      let payload: HarnessHookBody;
      try {
        payload = body.raw.trim() ? (JSON.parse(body.raw) as HarnessHookBody) : {};
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      // A hook must never take a Session down with it: a handler that throws
      // answers 500 and the harness's `|| true` swallows it.
      try {
        // The URL's event name is the fallback for a payload that carries
        // none — the hook writer knows which event it installed each entry
        // for, so a harness that omits it from the body is still routable.
        const result = handler(taskId, payload, url.searchParams.get("hookEvent") ?? "");
        res.writeHead(result.ok ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        log.warn("hook-receiver.handler-failed", { error: String(err) });
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "hook handling failed" }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCAL_HOOK_API_HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.on("error", (err) => log.warn("hook-receiver.error", { error: err.message }));

  log.info("hook-receiver.listening", { port });

  return {
    url: `http://${LOCAL_HOOK_API_HOST}:${port}`,
    token,
    port,
    close: () => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
    },
  };
}
