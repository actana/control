import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  PtyCoreLinkServer,
  type CoreMutationPort,
  type CoreQueryPort,
  type EventLogPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { CoreQuerySqlite } from "@actana/shared/core-query";
import { querySessionPage } from "@actana/shared/session-paging";
import { querySessionSnapshotPage, querySessions, type CoreMutationSqlite } from "@actana/shared/core-mutations";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import type { CoreLinkEvent } from "@actana/sdk/core";

// The `sessionsList` and `sessionRowsList` frames page (#960): with `limit` they
// answer one page plus `nextCursor` and `total`; without it they answer exactly
// as before, so an older Panel keeps working.

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
  on(event: string, cb: Listener): void {
    (this.listeners[event] ??= []).push(cb);
  }
  removeAllListeners(): void {
    this.listeners = {};
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners[event] ?? []) cb(...args);
  }
  receive(frame: unknown): void {
    this.emit("message", JSON.stringify(frame));
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
  ofType<T extends Record<string, unknown>>(type: string): T[] {
    return this.frames().filter((frame) => frame.type === type) as T[];
  }
  answerTo(reqId: string): Record<string, unknown> | undefined {
    return this.frames().find((frame) => frame.reqId === reqId);
  }
  /** Every `event` frame pushed to this connection, in the order it arrived. */
  events(): CoreLinkEvent[] {
    return this.ofType<{ event: CoreLinkEvent }>("event").map((frame) => frame.event);
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

function fakeEventLog() {
  const events: CoreLinkEvent[] = [];
  const port: EventLogPort = {
    appendEvent: (kind, payload, opts) => {
      const eventId = events.length + 1;
      events.push({
        eventId,
        ts: eventId,
        kind,
        payload,
        ptyId: opts?.ptyId ?? null,
        sessionId: opts?.sessionId ?? null,
      });
      return eventId;
    },
    readEventTail: (afterEventId, limit = 1_000) =>
      events.filter((event) => event.eventId > afterEventId).slice(0, limit),
    getLastEventId: () => events.length,
  };
  return { port, events };
}

function mockCore() {
  const ptySessions = new Map<string, string>();
  let nextPty = 0;
  let target: ((event: PtyCoreEvent) => void) | null = null;
  const core = {
    setEmitTarget: (fn: ((event: PtyCoreEvent) => void) | null) => {
      target = fn;
    },
    spawn: async (opts: { sessionId: string }) => {
      const ptyId = `pty-${++nextPty}`;
      ptySessions.set(ptyId, opts.sessionId);
      return { ptyId, hooksReportTurnStart: true };
    },
    write: (ptyId: string) => ptySessions.has(ptyId),
    resize: () => true,
    kill: (ptyId: string) => ptySessions.delete(ptyId),
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findBySession: () => ({ ptyId: null }),
    sessionIdForPty: (ptyId: string) => ptySessions.get(ptyId) ?? null,
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  };
  return { core: core as unknown as PtyCore, emit: (event: PtyCoreEvent) => target?.(event) };
}


function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready', pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, icon TEXT,
      title_manually_set INTEGER NOT NULL DEFAULT 0, claude_session_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function add(db: Database.Database, id: string, at: number, status = "finished", agent = "claude-code", archived = 0) {
  db.prepare(
    `INSERT INTO sessions (id, title, agent, status, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `title ${id}`, agent, status, archived, at, at);
}

describe("paged Session list frames (#960)", () => {
  let wss: FakeWebSocketServer;
  let db: Database.Database;
  let server: PtyCoreLinkServer;
  let probed: string[];

  const reader = () => db as unknown as CoreQuerySqlite;
  const writer = () => db as unknown as CoreMutationSqlite;

  beforeEach(() => {
    wss = new FakeWebSocketServer();
    db = openDb();
    probed = [];
    const queryPort: CoreQueryPort = {
      listSessionRows: () => [],
      listArchivedSessions: () => [],
      countArchivedSessions: () => 0,
      getSession: () => null,
      listSessionRowsPage: (query) => querySessionPage(reader(), query),
    };
    const mutationPort: CoreMutationPort = {
      mutateSession: () => null,
      listSessions: () =>
        querySessions(writer(), (id) => {
          probed.push(id);
          return null;
        }),
      listSessionsPage: (query) =>
        querySessionSnapshotPage(writer(), query, (id) => {
          probed.push(id);
          return `pty-${id}`;
        }),
    };
    server = new PtyCoreLinkServer(mockCore().core, {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      eventLog: fakeEventLog().port,
      queryPort,
      mutationPort,
    });
  });
  afterEach(() => server.close());

  async function ask(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ws = new FakeWebSocket();
    wss.connect(ws);
    ws.receive({ ...frame, reqId: "r" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return ws.answerTo("r")!;
  }

  it("sessionRowsList pages rows with nextCursor, total and the archived count", async () => {
    for (let i = 1; i <= 5; i++) add(db, `s${i}`, i);
    const first = await ask({ type: "sessionRowsList", limit: 2 }) as any;
    expect(first.type).toBe("sessionRowsListResult");
    expect(first.sessions.map((s: any) => s.sessionId)).toEqual(["s5", "s4"]);
    expect(first.total).toBe(5);
    const second = await ask({ type: "sessionRowsList", limit: 2, cursor: first.nextCursor }) as any;
    expect(second.sessions.map((s: any) => s.sessionId)).toEqual(["s3", "s2"]);
  });

  it("sessionRowsList without limit answers exactly today's shape", async () => {
    const answer = await ask({ type: "sessionRowsList" });
    expect(Object.keys(answer).sort()).toEqual(["archivedCount", "reqId", "sessions", "type"]);
  });

  it("sessionsList pages lean rows, probing the live PTY only for the page", async () => {
    for (let i = 1; i <= 5; i++) add(db, `s${i}`, i);
    const page = await ask({ type: "sessionsList", limit: 2 }) as { sessions: any[]; nextCursor: string; total: number };
    expect(page.sessions.map((s) => s.sessionId)).toEqual(["s5", "s4"]);
    expect(page.sessions[0]).toMatchObject({ ptyId: "pty-s5", title: "title s5", agent: "claude-code", status: "finished" });
    expect(page.total).toBe(5);
    expect(probed).toEqual(["s5", "s4"]);
  });

  it("sessionsList without limit answers today's shape: every active row, no paging fields", async () => {
    for (let i = 1; i <= 3; i++) add(db, `s${i}`, i);
    add(db, "arch", 9, "finished", "claude-code", 1);
    const answer = await ask({ type: "sessionsList" }) as { sessions: any[] };
    expect(Object.keys(answer).sort()).toEqual(["reqId", "sessions", "type"]);
    expect(answer.sessions.map((s) => s.sessionId)).toEqual(["s3", "s2", "s1"]);
    expect(Object.keys(answer.sessions[0]).sort()).toEqual(["lock", "ptyId", "sessionId", "status", "updatedAt"]);
  });

  it("applies the filters on the Core", async () => {
    add(db, "r", 1, "running", "codex");
    add(db, "f", 2, "finished", "claude-code");
    add(db, "old", 3, "finished", "claude-code", 1);
    const run = async (extra: object) =>
      ((await ask({ type: "sessionsList", limit: 10, ...extra })) as any).sessions.map((s: any) => s.sessionId);
    expect(await run({ status: "running" })).toEqual(["r"]);
    expect(await run({ harness: "claude-code" })).toEqual(["f"]);
    expect(await run({ archived: true })).toEqual(["old"]);
    expect(await run({ q: "title f" })).toEqual(["f"]);
  });

  it("sessionRowsList answers only the pinned rows when asked, with their true total", async () => {
    for (const [id, at] of [["a", 1], ["b", 2], ["c", 3]] as const) add(db, id, at);
    db.prepare(`UPDATE sessions SET pinned = 1 WHERE id IN ('a', 'c')`).run();
    const answer = (await ask({ type: "sessionRowsList", limit: 10, archived: false, pinned: true })) as any;
    expect(answer.sessions.map((s: any) => s.sessionId)).toEqual(["c", "a"]);
    expect(answer.total).toBe(2);
  });

  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 5, cursor: "garbage" },
    { limit: 5, status: "bogus" },
  ])("refuses a bad request %j with an error frame", async (extra) => {
    for (const type of ["sessionsList", "sessionRowsList"]) {
      const answer = await ask({ type, ...extra });
      expect(answer.type).toBe("error");
    }
  });
});
