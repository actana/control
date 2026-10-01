import {
  CoreSharedError,
  type CoreShared,
  type SharedChange,
  type SharedEntry,
  type SharedFile,
  type SharedWatchResult,
} from "@actana/sdk/shared";
import type { DispatchLog, SessionStarter, StartSessionRequest, StartedSession } from "../types";

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
  private n = 0;

  readonly startSession: SessionStarter = async (request) => {
    this.starts.push(request);
    if (this.failWith) throw new Error(this.failWith);
    const id = `session_${(this.n += 1)}`;
    let onExit: ((e: { exitCode: number }) => void) | null = null;
    const record = {
      id,
      request,
      exit: (code: number) => onExit?.({ exitCode: code }),
      disposed: false,
    };
    this.sessions.push(record);
    const started: StartedSession = {
      sessionId: id,
      onExit: (cb) => {
        onExit = cb;
      },
      dispose: () => {
        record.disposed = true;
      },
    };
    return started;
  };
}

export function collectingLog(): DispatchLog & { errors: string[]; infos: string[] } {
  const errors: string[] = [];
  const infos: string[] = [];
  return { errors, infos, error: (m) => errors.push(m), info: (m) => infos.push(m) };
}
