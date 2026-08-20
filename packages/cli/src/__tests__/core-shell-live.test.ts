// `actana core shell` against a Core that is actually running (#162).
//
// `core-shell.test.ts` injects `deps.openShell` and drives the command against
// a fake channel, which is what makes "is raw mode restored when the link
// drops?" a question a unit test can answer at all. What that leaves uncovered
// is the channel itself — `core-shell-channel.ts`, the module that turns the
// SDK's PTY vocabulary into the four things a shell needs — and it is the one
// piece whose bugs would only show up against a real Core.
//
// So this suite brings one, the same way `in-process-core.test.ts` does for
// `core status`: `packages/core`'s real `PtyCoreLinkServer` on a real `wss://`
// port, with mTLS material from the Core's own `generateCertMaterial` and a
// bearer its own verifier accepts. The PTY manager underneath is a fake — a
// real one would need `node-pty`, which is exactly the dependency the published
// CLI exists to not have — but everything between the CLI and it is real: the
// blob, the handshake, the `spawn` frame, the subscription, the `data` and
// `exit` frames coming back.
//
// The harness is deliberately its own rather than shared with
// `in-process-core.test.ts`: a `shellSession` spawn needs a PTY manager that
// answers, and that file's is written to throw if `core status` ever reaches
// it, which is a property worth keeping.

import { describe, it, expect, afterEach } from "vitest";
import { Server } from "node:net";
import https from "node:https";
import { WebSocketServer } from "ws";
import {
  PtyCoreLinkServer,
  type WebSocketLike as ServerSocketLike,
  type WebSocketServerLike,
} from "@actana/core/pty-core-link-server";
import { generateCertMaterial } from "@actana/shared/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { decodeRegistrationBlobText } from "../registration-blob-file.ts";
import { openCoreShell } from "../core-shell-channel.ts";
import type { CoreShellExit } from "../core-shell-channel.ts";

const SECRET = "cli-core-shell-live-secret-at-least-32-bytes";
const CORE_ID = "core_shell_live";

/** One PTY the fake manager is holding. */
type FakePty = {
  id: string;
  taskId: string;
  cols: number;
  rows: number;
  /** Everything the CLI wrote to it, joined. */
  input: string[];
};

/**
 * A PTY manager that records instead of forking.
 *
 * It answers `spawn`, `write`, `resize` and `kill` — the four frames a shell
 * session actually sends — and pushes `data` and `exit` back through the emit
 * target, which is how a real one delivers a process's output. Nothing here
 * runs a program: the point is the wire, not `node-pty`.
 */
function echoingPtyCore() {
  const ptys = new Map<string, FakePty>();
  const spawns: Array<Record<string, unknown>> = [];
  let emit: ((event: Record<string, unknown>) => void) | null = null;
  let seq = 0;
  let nextId = 0;

  const core = {
    setEmitTarget: (fn: ((event: Record<string, unknown>) => void) | null) => {
      emit = fn;
    },
    spawn: async (opts: Record<string, unknown>) => {
      spawns.push(opts);
      const id = `pty_live_${++nextId}`;
      ptys.set(id, {
        id,
        taskId: String(opts.taskId),
        cols: Number(opts.cols ?? 0),
        rows: Number(opts.rows ?? 0),
        input: [],
      });
      return { ptyId: id, hooksReportTurnStart: false };
    },
    write: (ptyId: string, data: string) => {
      const pty = ptys.get(ptyId);
      if (!pty) return false;
      pty.input.push(data);
      return true;
    },
    resize: (ptyId: string, cols: number, rows: number) => {
      const pty = ptys.get(ptyId);
      if (!pty) return false;
      pty.cols = cols;
      pty.rows = rows;
      return true;
    },
    kill: (ptyId: string) => ptys.has(ptyId),
    killLaunchProcesses: () => ({ killed: [], errors: [] }),
    findByTask: (taskId: string) => ({
      ptyId: [...ptys.values()].find((p) => p.taskId === taskId)?.id ?? null,
    }),
    replay: () => ({ data: "", nextSeq: 0 }),
    taskIdForPty: (ptyId: string) => ptys.get(ptyId)?.taskId ?? null,
  };

  return {
    core,
    spawns,
    pty: (ptyId: string) => ptys.get(ptyId),
    /** The remote process prints. */
    say: (ptyId: string, data: string) => emit?.({ type: "data", ptyId, data, seq: ++seq }),
    /** The remote process ends. */
    end: (ptyId: string, exit: CoreShellExit) =>
      emit?.({ type: "exit", ptyId, exitCode: exit.exitCode, signal: exit.signal }),
  };
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

/** The real `wss://` server, with the bound port recorded. A mutual handshake. */
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

afterEach(() => {
  server?.close();
  server = null;
});

/** A Core on a real port, its fake PTY manager, and the blob for it. */
async function startCore() {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const port = await freePort();
  const bound = { port: 0 };
  const machine = echoingPtyCore();

  server = new PtyCoreLinkServer(machine.core as never, {
    port,
    host: "127.0.0.1",
    createServer: recordingCreateServer(bound),
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier: (bearer: string) => verifyBearer(bearer, SECRET),
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

  const blobText = Buffer.from(
    JSON.stringify({
      endpoint: `wss://127.0.0.1:${bound.port}`,
      label: "shell-live",
      caCert: material.ca.cert,
      clientCert: material.client.cert,
      clientKey: material.client.key,
      bearer: signBearer({ coreId: CORE_ID, exp: Date.now() + 3_600_000 }, SECRET),
    }),
    "utf8",
  ).toString("base64");

  const decoded = decodeRegistrationBlobText(blobText);
  if (!decoded.ok) throw new Error(`the test's own blob was rejected: ${decoded.error}`);
  return { blob: decoded.blob, machine };
}

/** Wait for something the far side has to deliver over a socket. */
async function until(what: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("the shell channel, against a Core in this process", () => {
  it("spawns a free-form login shell, not a harness and not a project", async () => {
    const { blob, machine } = await startCore();
    const channel = await openCoreShell(blob, { cols: 120, rows: 40, connectTimeoutMs: 10_000 });
    try {
      // `shellSession: true` is the Core's VM-shell spawn mode: no `agent`, no
      // `cwd`, no project root to be confined to. That is what makes this the
      // escape hatch F3 says it is, rather than another way to start a harness.
      expect(machine.spawns).toHaveLength(1);
      expect(machine.spawns[0]).toMatchObject({ shellSession: true, cols: 120, rows: 40 });
      expect(machine.spawns[0]!.agent).toBeUndefined();
      expect(String(machine.spawns[0]!.taskId)).toMatch(/^cli_shell_/);
      // No starting command: the operator gets their own login shell.
      expect(machine.spawns[0]!.command ?? "").toBe("");
    } finally {
      channel.close();
    }
  }, 30_000);

  it("carries keystrokes out and bytes back over the real link", async () => {
    const { blob, machine } = await startCore();
    const channel = await openCoreShell(blob, { cols: 80, rows: 24, connectTimeoutMs: 10_000 });
    try {
      const painted: string[] = [];
      channel.onData((data) => painted.push(data));

      await channel.write("echo hi\r");
      // `Ctrl-C` as a byte, which is the only way it reaches a remote process.
      await channel.write("\u0003");
      await until(() => (machine.pty(channel.ptyId)?.input.length ?? 0) >= 2, "the writes to land");
      expect(machine.pty(channel.ptyId)!.input.join("")).toBe("echo hi\r\u0003");

      machine.say(channel.ptyId, "hi\r\n");
      await until(() => painted.length > 0, "the output to come back");
      expect(painted.join("")).toBe("hi\r\n");
    } finally {
      channel.close();
    }
  }, 30_000);

  it("propagates a resize to the PTY the Core is holding", async () => {
    const { blob, machine } = await startCore();
    const channel = await openCoreShell(blob, { cols: 80, rows: 24, connectTimeoutMs: 10_000 });
    try {
      await channel.resize(132, 50);
      await until(() => machine.pty(channel.ptyId)?.cols === 132, "the resize to land");
      expect(machine.pty(channel.ptyId)).toMatchObject({ cols: 132, rows: 50 });
    } finally {
      channel.close();
    }
  }, 30_000);

  it("reports the remote exit, which is where the CLI's exit status comes from", async () => {
    const { blob, machine } = await startCore();
    const channel = await openCoreShell(blob, { cols: 80, rows: 24, connectTimeoutMs: 10_000 });
    try {
      const seen: CoreShellExit[] = [];
      channel.onExit((exit) => seen.push(exit));

      machine.end(channel.ptyId, { exitCode: 42 });
      await until(() => seen.length > 0, "the exit to arrive");
      expect(seen[0]).toMatchObject({ exitCode: 42 });
    } finally {
      channel.close();
    }
  }, 30_000);

  it("ignores another PTY's stream, so one shell is one shell", async () => {
    // Two `core shell` invocations against one Core share nothing but the
    // machine. A channel that painted the other one's bytes would be a
    // cross-session leak in the most literal sense.
    const { blob, machine } = await startCore();
    const first = await openCoreShell(blob, { cols: 80, rows: 24, connectTimeoutMs: 10_000 });
    const second = await openCoreShell(blob, { cols: 80, rows: 24, connectTimeoutMs: 10_000 });
    try {
      expect(first.ptyId).not.toBe(second.ptyId);
      const painted: string[] = [];
      const exits: CoreShellExit[] = [];
      first.onData((data) => painted.push(data));
      first.onExit((exit) => exits.push(exit));

      machine.say(second.ptyId, "not yours\r\n");
      machine.end(second.ptyId, { exitCode: 1 });
      // Then something for the first, which must be the only thing it sees.
      machine.say(first.ptyId, "yours\r\n");
      await until(() => painted.length > 0, "the first shell's output");

      expect(painted.join("")).toBe("yours\r\n");
      expect(exits).toEqual([]);
    } finally {
      first.close();
      second.close();
    }
  }, 30_000);
});
