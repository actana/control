import {
  CoreSharedError,
  type CoreShared,
  type SharedChange,
  type SharedEntry,
  type SharedFile,
  type SharedWatchResult,
} from "@actana/sdk/shared";
import { RESUME_REFUSALS, type DispatchLog, type ResumeSessionRequest, type SessionLiveness, type SessionResumer, type SessionStarter, type SessionStatusReader, type SessionStopResult, type SessionStopper, type StartSessionRequest, type StartedSession } from "../types";

/** A clock a test moves by hand. */
export class FakeClock {
  constructor(public t = 1_000_000) {}
  now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * An in-memory `CoreShared` with the semantics the result watcher relies on: `watch()` with no cursor lists every
 * file, `watch(cursor)` returns what changed since, files carry the fake clock's modification time, and a failure
 * can be switched on per operation. It is the fake CoreShared of the issue's test boundary.
 */
export class FakeShared implements CoreShared {
  readonly files = new Map<string, { body: Uint8Array; mtime: number }>();
  private readonly log: { seq: number; path: string; deleted: boolean }[] = [];
  /** Every call made, in order, as `op path`. */
  readonly calls: string[] = [];
  /** Paths `watch` reports that are not there to read (created and gone within one poll). */
  ghosts: string[] = [];
  /** `watch` reports nothing new: the change feed missed it. */
  watchBlind = false;
  failing: Partial<Record<"watch" | "get" | "put" | "list" | "move", string>> = {};

  constructor(private readonly clock: FakeClock) {}

  private check(op: keyof FakeShared["failing"], what = ""): void {
    this.calls.push(`${op} ${what}`.trim());
    const message = this.failing[op];
    if (message) throw new CoreSharedError("unavailable", message);
  }

  /** Write as the agent would: the file gets the clock's time now. */
  write(path: string, body: string, mtime = this.clock.now()): void {
    this.files.set(path, { body: new TextEncoder().encode(body), mtime });
    this.log.push({ seq: this.log.length + 1, path, deleted: false });
  }

  text(path: string): string | null {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.body) : null;
  }

  async list(path: string): Promise<SharedEntry[]> {
    this.check("list", path);
    return [...this.files.entries()]
      .filter(([p]) => p.startsWith(path) && !p.slice(path.length).includes("/"))
      .map(([p, f]) => ({ path: p, kind: "file" as const, size: f.body.length, modifiedAt: new Date(f.mtime) }));
  }

  async get(path: string): Promise<SharedFile> {
    this.check("get", path);
    const f = this.files.get(path);
    if (!f) throw new CoreSharedError("not-found", "no such file");
    return { path, kind: "file", size: f.body.length, modifiedAt: new Date(f.mtime), body: f.body };
  }

  async put(path: string, body: Uint8Array | string): Promise<void> {
    this.check("put", path);
    this.write(path, typeof body === "string" ? body : new TextDecoder().decode(body));
  }

  async mkdir(): Promise<void> {}

  async rm(path: string): Promise<void> {
    this.files.delete(path);
    this.log.push({ seq: this.log.length + 1, path, deleted: true });
  }

  async move(from: string, to: string): Promise<void> {
    this.check("move", `${from} -> ${to}`);
    const f = this.files.get(from);
    if (!f) throw new CoreSharedError("not-found", "no such file");
    if (this.files.has(to)) throw new CoreSharedError("exists", "taken");
    this.files.delete(from);
    this.log.push({ seq: this.log.length + 1, path: from, deleted: true });
    // A rename keeps the file's time, as it does on a disk and in S3's copy-then-delete.
    this.files.set(to, f);
    this.log.push({ seq: this.log.length + 1, path: to, deleted: false });
  }

  async upload(): Promise<string[]> {
    return [];
  }

  async watch(since?: string): Promise<SharedWatchResult> {
    this.check("watch", since ?? "(all)");
    const tip = this.log.length;
    if (since === undefined) {
      const changes: SharedChange[] = [...this.files.entries()].map(([path, f]) => ({
        path,
        kind: "file",
        deleted: false,
        size: f.body.length,
        modifiedAt: new Date(f.mtime),
      }));
      return { changes, cursor: `c${tip}` };
    }
    const from = Number(since.slice(1));
    if (this.watchBlind) return { changes: [], cursor: `c${tip}` };
    const seen = new Set<string>();
    const changes: SharedChange[] = [];
    for (const entry of this.log.filter((e) => e.seq > from)) {
      const f = this.files.get(entry.path);
      if (entry.deleted || !f) {
        changes.push({ path: entry.path, kind: "file", deleted: true });
      } else if (!seen.has(entry.path)) {
        seen.add(entry.path);
        changes.push({ path: entry.path, kind: "file", deleted: false, size: f.body.length, modifiedAt: new Date(f.mtime) });
      }
    }
    for (const path of this.ghosts) changes.push({ path, kind: "file", deleted: false, size: 1, modifiedAt: new Date(this.clock.now()) });
    return { changes, cursor: `c${tip}` };
  }

  async signedUrl(): Promise<never> {
    throw new Error("not used");
  }
}

/** A fake Core: records every Session it is asked to start, and lets a test end one. */
export class FakeCore {
  readonly starts: StartSessionRequest[] = [];
  readonly sessions: { id: string; request: StartSessionRequest; exit: (code: number) => void; disposed: boolean }[] = [];
  failWith: string | null = null;
  /** Runs when a Session is asked for, before it is recorded: what the Core can see at that moment. */
  onStart: (() => unknown) | null = null;
  private n = 0;
  /** Every Session the Panel asked this Core to stop, in order. */
  readonly stops: { coreId: string; sessionId: string }[] = [];
  /** What a stop answers: `unreachable` is a Core that is offline. */
  stopOutcome: SessionStopResult = { outcome: "stopped", detail: null };

  /** The Sessions the Core reports live; null is an unreachable Core (no answer). Started Sessions are added. */
  live: Set<string> | null = new Set();
  /** Every Core the Panel asked about, in order. */
  readonly liveCalls: string[] = [];

  /** What the Core reports as each Session's status; null is a Core that gives no answer. */
  statuses: Map<string, string> | null = new Map();
  /** Every `[coreId, sessionIds]` the Panel asked the status of, in order. */
  readonly statusCalls: [string, string[]][] = [];
  /** The status listeners a Session holds right now (released by `dispose`). */
  listeners(id: string): number {
    return this.statusListeners.get(id)?.size ?? 0;
  }
  private readonly statusListeners = new Map<string, Set<(status: string) => void>>();
  /** The Core reports a new status for a Session: the subscribed listeners hear it and the polled map follows. */
  emitStatus(id: string, status: string): void {
    this.statuses?.set(id, status);
    for (const cb of [...(this.statusListeners.get(id) ?? [])]) cb(status);
  }

  readonly sessionStatuses: SessionStatusReader = async (coreId, sessionIds) => {
    this.statusCalls.push([coreId, [...sessionIds]]);
    if (!this.statuses) return null;
    return new Map(sessionIds.flatMap((id) => (this.statuses!.has(id) ? [[id, this.statuses!.get(id)!] as [string, string]] : [])));
  };

  readonly liveSessions: SessionLiveness = async (coreId, sessionIds) => {
    this.liveCalls.push(coreId);
    return this.live ? new Set(sessionIds.filter((id) => this.live!.has(id))) : null;
  };

  readonly stopSession: SessionStopper = async (target) => {
    this.stops.push({ ...target });
    // A stopped harness has no PTY any more: its slot is free.
    if (this.stopOutcome.outcome === "stopped" || this.stopOutcome.outcome === "not-running") this.live?.delete(target.sessionId);
    return this.stopOutcome;
  };

  /** The Core's cap on live harness PTYs (`DEFAULT_MAX_LIVE_HARNESS_PTYS`, 8); null is no cap. A start over it is refused as the Core refuses it. */
  maxLivePtys: number | null = null;

  /** The Session rows this Core holds: the harness session id each captured (null: none captured yet). */
  readonly rows = new Map<string, { claudeSessionId: string | null }>();
  /** A started Session captures a harness session id (the Core's capture hook); switch off for a harness that has not reported one. */
  capturesSessionId = true;
  private readonly exitHandlers = new Map<string, (e: { exitCode: number }) => void>();
  /** Every Session the Panel asked this Core to resume or type into, in order. */
  readonly resumes: ResumeSessionRequest[] = [];
  /** What was typed into a Session after it started: `resume` reopened its harness first, `send` typed into a live one. */
  readonly typed: { sessionId: string; text: string; how: "resume" | "send" }[] = [];
  /** A resume throws this (a full Core or a link that is gone, as the real one does); null resumes. */
  resumeFailsWith: string | null = null;
  /** The Core refuses the resume with a refusal. */
  resumeRefusal: ReturnType<typeof RESUME_REFUSALS.resumeRefused> | null = null;
  /** The resumed harness exits at once (a refused `--resume`). */
  resumeExitsAtOnce = false;
  /** The harness takes the typed line when it is live. */
  acceptsSend = true;

  private handle(id: string, record: { disposed: boolean }): StartedSession {
    return {
      sessionId: id,
      onExit: (cb) => {
        this.exitHandlers.set(id, cb);
      },
      onStatus: (cb) => {
        this.statusListeners.set(id, (this.statusListeners.get(id) ?? new Set()).add(cb));
      },
      dispose: () => {
        record.disposed = true;
        this.statusListeners.delete(id);
      },
    };
  }

  readonly startSession: SessionStarter = async (request) => {
    await this.onStart?.();
    this.starts.push(request);
    if (this.failWith) throw new Error(this.failWith);
    if (this.maxLivePtys !== null && (this.live?.size ?? 0) >= this.maxLivePtys) {
      throw new Error(`pty:spawn refused: this Core already runs ${this.maxLivePtys} live harness PTYs (the limit).`);
    }
    const id = `session_${(this.n += 1)}`;
    const record = {
      id,
      request,
      exit: (code: number) => this.exitHandlers.get(id)?.({ exitCode: code }),
      disposed: false,
    };
    this.sessions.push(record);
    this.rows.set(id, { claudeSessionId: this.capturesSessionId ? `claude-${id}` : null });
    this.live?.add(id);
    return this.handle(id, record);
  };

  readonly resumeSession: SessionResumer = async (request) => {
    this.resumes.push(request);
    if (this.resumeFailsWith) throw new Error(this.resumeFailsWith);
    const record = this.sessions.find((s) => s.id === request.sessionId);
    const row = this.rows.get(request.sessionId);
    if (!record || !row) return { kind: "cannot", refusal: RESUME_REFUSALS.sessionGone };
    if (!row.claudeSessionId) return { kind: "cannot", refusal: RESUME_REFUSALS.noSessionId };
    if (this.live?.has(request.sessionId)) {
      // A Session parked on a dialog reports `needs-input`; the Core refuses stamped writes into it (`blocked`, #924), and the
      // real `sendIntoRunningSession` writes only stamped ones, so the resumer answers `sendRefused` and nothing is typed.
      if (!this.acceptsSend || this.statuses?.get(request.sessionId) === "needs-input") return { kind: "cannot", refusal: RESUME_REFUSALS.sendRefused, stillLive: true };
      this.typed.push({ sessionId: request.sessionId, text: request.prompt, how: "send" });
      return { kind: "sent", session: this.handle(request.sessionId, record) };
    }
    if (this.resumeRefusal) return { kind: "cannot", refusal: this.resumeRefusal };
    if (this.maxLivePtys !== null && (this.live?.size ?? 0) >= this.maxLivePtys) {
      throw new Error(`pty:spawn refused: this Core already runs ${this.maxLivePtys} live harness PTYs (the limit).`);
    }
    if (this.resumeExitsAtOnce) return { kind: "cannot", refusal: RESUME_REFUSALS.exitedAtOnce };
    record.disposed = false;
    this.live?.add(request.sessionId);
    this.typed.push({ sessionId: request.sessionId, text: request.prompt, how: "resume" });
    return { kind: "resumed", session: this.handle(request.sessionId, record) };
  };
}

export function collectingLog(): DispatchLog & { errors: string[]; infos: string[] } {
  const errors: string[] = [];
  const infos: string[] = [];
  return { errors, infos, error: (m) => errors.push(m), info: (m) => infos.push(m) };
}
