import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapCoreDb } from "../core-db-bootstrap";
import { CoreSessionWriter } from "../core-session-writer";
import {
  configureCoreQueryStore,
  coreQueryStore,
  disposeCoreQueryStore,
} from "../core-query-store";
import {
  configureCoreMutationStore,
  coreMutationStore,
  disposeCoreMutationStore,
} from "../core-mutation-store";
import {
  PtyCoreLinkServer,
  type CoreMutationPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore } from "../pty-manager";

// The Task-to-Session rename is a hard cut (actana/control#556, decided by the
// owner): no alias, no dual-read, no migration. The positive half — `sessionId`,
// `session:*`, `sessions` — is pinned by every renamed suite. This file pins the
// negative half, because a Core that quietly kept answering to the old names
// would pass all of those: the names are gone, not merely joined by new ones.

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-core-session-hard-cut-"));
}

describe("a fresh Core database has no Task vocabulary", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = tmpDir();
  });

  afterEach(() => {
    disposeCoreMutationStore();
    disposeCoreQueryStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("names no table, column or index after a task", () => {
    const { dbPath } = bootstrapCoreDb(userDataDir);
    const db = new Database(dbPath, { readonly: true });
    try {
      const objects = db.prepare("SELECT type, name FROM sqlite_master").all() as {
        type: string;
        name: string;
      }[];
      const tables = objects.filter((o) => o.type === "table").map((o) => o.name);
      expect(tables).toContain("sessions");
      const offenders: string[] = objects.filter((o) => /task/i.test(o.name)).map((o) => o.name);
      for (const table of tables) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        for (const column of columns) {
          if (/task/i.test(column.name)) offenders.push(`${table}.${column.name}`);
        }
      }
      expect(offenders).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("appends only session:* events for a Session's whole lifecycle", () => {
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
    const kinds: string[] = [];
    const writer = new CoreSessionWriter({
      mutationPort: coreMutationStore,
      queryPort: coreQueryStore,
      eventLog: {
        appendEvent: (kind) => kinds.push(kind),
        readEventTail: () => [],
        getLastEventId: () => kinds.length,
      },
    });
    coreMutationStore.mutateProject({ op: "create", projectId: "p1", name: "p", path: userDataDir });
    writer.mutate({ op: "create", sessionId: "s1", projectId: "p1", title: "work", agent: "claude-code" });
    writer.mutate({ op: "update", sessionId: "s1", status: "running" });
    writer.mutate({ op: "update", sessionId: "s1", pinned: true });
    writer.mutate({ op: "update", sessionId: "s1", icon: "bug" });
    writer.mutate({ op: "update", sessionId: "s1", archived: true });
    writer.mutate({ op: "update", sessionId: "s1", archived: false });
    writer.mutate({ op: "update", sessionId: "s1", status: "finished" });
    writer.mutate({ op: "delete", sessionId: "s1" });

    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.filter((kind) => !kind.startsWith("session:"))).toEqual([]);
  });
});

describe("a Core refuses the Task frames of a 0.17 client", () => {
  type Listener = (...args: unknown[]) => void;

  class FakeWebSocket {
    readyState = 1;
    sent: string[] = [];
    private listeners: Record<string, Listener[]> = {};
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {}
    on(event: string, cb: Listener): void {
      (this.listeners[event] ??= []).push(cb);
    }
    removeAllListeners(): void {
      this.listeners = {};
    }
    receive(frame: unknown): void {
      for (const cb of this.listeners.message ?? []) cb(JSON.stringify(frame));
    }
    frames(): Array<Record<string, unknown>> {
      return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    }
  }

  class FakeWebSocketServer {
    private connCb: ((ws: WebSocketLike) => void) | null = null;
    connect(ws: FakeWebSocket): void {
      this.connCb?.(ws as unknown as WebSocketLike);
    }
    close(): void {}
    on(event: string, cb: Listener): void {
      if (event === "connection") this.connCb = cb as (ws: WebSocketLike) => void;
    }
  }

  const legacyFrames: Array<Record<string, unknown>> = [
    { type: "tasksList", reqId: "r" },
    { type: "archivedTasksList", reqId: "r" },
    { type: "tasksMutate", reqId: "r", mutation: { op: "delete", taskId: "t1" } },
    { type: "findByTask", reqId: "r", taskId: "t1" },
    { type: "claim", reqId: "r", taskId: "t1" },
    { type: "release", reqId: "r", taskId: "t1" },
    { type: "forceTakeover", reqId: "r", taskId: "t1" },
    { type: "harnessPrompt", reqId: "r", taskId: "t1", prompt: "go" },
    { type: "sessionsMutate", reqId: "r", mutation: { op: "delete", taskId: "t1" } },
    { type: "sessionsMutate", reqId: "r", mutation: { op: "update", taskId: "t1", status: "running" } },
  ];

  it.each(legacyFrames.map((frame, i) => [`${String(frame.type)} #${i}`, frame] as const))(
    "answers a legacy %s with invalid frame and reaches no port",
    (_name, frame) => {
      const calls: string[] = [];
      const mutationPort: CoreMutationPort = {
        mutateProject: () => {
          calls.push("mutateProject");
          return null;
        },
        mutateSession: () => {
          calls.push("mutateSession");
          return null;
        },
        listSessions: () => {
          calls.push("listSessions");
          return [];
        },
      };
      const core = {
        setEmitTarget: () => {},
        findBySession: () => {
          calls.push("findBySession");
          return { ptyId: null };
        },
        write: () => {
          calls.push("write");
          return false;
        },
        killAll: () => {},
      } as unknown as PtyCore;
      const wss = new FakeWebSocketServer();
      const server = new PtyCoreLinkServer(core, {
        port: 0,
        createServer: () => wss as unknown as WebSocketServerLike,
        mutationPort,
        liveEventPollMs: 10_000,
      });
      try {
        const ws = new FakeWebSocket();
        wss.connect(ws);
        const before = ws.frames().length;
        ws.receive(frame);
        // The refusal is a frame on the wire: there is no stderr or exit code
        // in a Core link, so this is where a dropped frame surfaces.
        const answered = ws.frames().slice(before);
        expect(answered).toHaveLength(1);
        expect(answered[0]).toMatchObject({ type: "error", message: "invalid frame" });
        expect(calls).toEqual([]);
      } finally {
        server.close();
      }
    },
  );
});
