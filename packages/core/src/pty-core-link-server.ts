// WebSocket server for the loopback core-link.
//
// Hosts a `ws.WebSocketServer` on `ws://127.0.0.1:<port>` and wires incoming
// frames to a `PtyCore`. The Core process (core-runner.mjs) loads
// this alongside the core; the Panel service never imports this module.
//
// Loopback-only (trusted) — no auth yet. A later issue adds mTLS + bearer auth
// before the same server listens on a non-loopback interface.
//
// Many connections are accepted at once (issue 141, ADR 0024 D1): the Panel,
// the CLI, an SDK automation. Each gets its own {@link ActiveConnection} — its
// own auth state, event cursor, poll loop and heartbeat — and a new connection
// never closes an existing one. `PtyCore` state (PTYs, tasks, the event log) is
// untouched by a connection arriving or leaving. When the last connection goes,
// `core.setEmitTarget(null)` stops output delivery — the PTY buffer retains
// everything for replay on reconnect.

import log from "./log";
import type { WebSocketServer, WebSocket } from "ws";
import {
  CORE_LINK_PROTOCOL_VERSION,
  HARNESS_INSTALL_FAILED_EVENT_KIND,
  parseCoreLinkRequestFrame,
  serializeCoreLinkFrame,
  type CoreLinkHarnessAvailabilityMap,
  type CoreLinkHarnessInstallFailedPayload,
  type CoreLinkDirListing,
  type CoreLinkEvent,
  type CoreLinkProjectMutation,
  type CoreLinkRequestFrame,
  type CoreLinkServerFrame,
  type CoreLinkProjectSnapshot,
  type CoreLinkSessionSnapshot,
  type CoreLinkTaskMutation,
  type CoreLinkTaskSnapshot,
  type CoreLinkLaunchProcessKillResult,
} from "@actana/shared/core-link-frames";
// Re-export the snapshot types so tests / callers can import them from the
// server module alongside {@link CoreQueryPort} (the per-Core navigation
// query port, issue 07).
export type { CoreLinkProjectSnapshot, CoreLinkTaskSnapshot };
import type { PtyCore, PtyCoreEvent } from "./pty-manager";
import { CoreTaskWriter } from "./core-task-writer";

/**
 * The slice of the event-log store the server needs. The real implementation
 * (event-log-store.ts) opens a read-write handle to the shared
 * SQLite; tests inject an in-memory fake. Methods mirror the pure helpers in
 * src/shared/event-log.ts but operate on the store's own connection.
 */
export interface EventLogPort {
  /** Append an event; return its sequential eventId, or 0 if not recorded. */
  appendEvent(
    kind: string,
    payload: string,
    opts?: { ptyId?: string | null; taskId?: string | null },
  ): number;
  /** Read every event with eventId > afterEventId, ascending. */
  readEventTail(afterEventId: number, limit?: number): CoreLinkEvent[];
  /** The highest eventId in the log, or 0 when empty. */
  getLastEventId(): number;
}

/**
 * Read-only access to the Core's project + task tables for the per-Core
 * navigation + Fleet view (issue 07, ADR 0001). The Core is the single
 * source of truth for projects and tasks; the Panel holds none. The
 * `projectsList` / `tasksList` core-link frames delegate to this port so the
 * Panel can render a Core's projects/tasks as live snapshots without a
 * separate HTTP round-trip per item — and without the Panel ever persisting
 * them.
 *
 * The real implementation (core-query-store.ts) reads the shared
 * SQLite read-only; tests inject an in-memory fake. When omitted, the server
 * answers both frames with empty results (backward compat — a Core with no
 * query port wired is still a valid PTY-only Core).
 */
export interface CoreQueryPort {
  /** Every project on this Core, as a flattened snapshot. */
  listProjects(): CoreLinkProjectSnapshot[];
  /**
   * Every active task on this Core (optionally filtered to one project). The
   * Core omits archived tasks — the Fleet view is for active work, and the
   * Panel caches nothing, so archived rows never cross the active path. There
   * is no argument that changes this; the Archived view has its own frame.
   */
  listTasks(projectId?: string): CoreLinkTaskSnapshot[];
  /**
   * Every archived task on this Core (optionally filtered to one project) —
   * the exact mirror of `listTasks`, answering the `archivedTasksList` frame.
   * A separate method rather than a flag on `listTasks`, so no argument to the
   * active path can make it return an archived row (issue 62, ADR 0019).
   */
  listArchivedTasks(projectId?: string): CoreLinkTaskSnapshot[];
  /**
   * How many archived tasks the same scope holds. Rides the `tasksList`
   * answer so the Panel can gate and label its Archived tab continuously
   * without fetching a single archived row (ADR 0019).
   */
  countArchivedTasks(projectId?: string): number;
  /**
   * One task by id, or `null` when this Core has no such row. Unlike
   * `listTasks` an archived row still answers — a caller asking by id wants
   * that row's facts, not a browse of active work. The server reads it to
   * learn a task's status *before* a mutation lands, which is what tells a
   * genuine finish from a re-patch of an already-finished Session (issue 20).
   */
  getTask(taskId: string): CoreLinkTaskSnapshot | null;
}

/**
 * Read-write access to the Core's projects + tasks tables for the
 * `projectsMutate` / `tasksMutate` / `sessionsList` core-link frames (issue
 * 04, ADR 0004). The Core process owns the write path against its SQLite;
 * on a remote VM no sibling stateful server runs, so mutations go through
 * this port directly. Path validation for projects lives on the Core (a
 * Project's `path` is a VM path per CONTEXT.md) — the port throws a
 * `ProjectPathError`-flavored error on invalid input and the server
 * translates it into an actionable `error` frame.
 *
 * The real implementation (core-mutation-store.ts) opens the
 * shared SQLite read-write; tests inject an in-memory fake. When omitted,
 * `projectsMutate` / `tasksMutate` return `null` and `sessionsList` returns
 * `[]` — the same "PTY-only Core is a valid Core" backward compat the
 * query port has.
 */
/**
 * Snapshot access to the Core's CLI availability map (issue 11). The store
 * owns probing PATH + emitting `agents:availabilityChanged` events; this port
 * is the read-only slice the server needs to answer the fresh-Panel snapshot
 * request. When omitted (a Core with no availability probe wired, or a
 * test), the server answers `agentsAvailabilityList` with an empty map —
 * the Panel's per-Core store falls back to the "checking…" affordance.
 */
export interface HarnessAvailabilityPort {
  /** Current availability map for every managed agent. */
  snapshot(): CoreLinkHarnessAvailabilityMap;
}

/**
 * Installing a missing Harness on this machine (issue 83, ADR 0021). The Panel
 * can see a CLI is missing but cannot install it — the Core owns the machine.
 * This port is that install, and `harness-install-service.ts` is the real one;
 * tests inject a fake. When omitted, `harnessInstall` is refused outright with
 * a message rather than acked, so no Panel row waits for an install that was
 * never going to happen.
 *
 * Neither method may throw, and `install` must resolve only once the Harness is
 * actually available (or definitively is not) — the ack has long since gone out
 * and the Panel is waiting on the event log, not on this promise.
 */
export interface HarnessInstallPort {
  /** Is this an id this Core knows how to install? */
  installable(harnessId: string): boolean;
  /** Run the vendor installer, then re-probe. Resolves to the verdict. */
  install(harnessId: string): Promise<{ ok: boolean; message?: string }>;
}

/**
 * The Core's own filesystem, as the Panel's folder picker browses it
 * (web-panel issue 06). The Panel runs in a browser and has no disk to offer;
 * a Project's path is a VM path that only this process can resolve. Both
 * methods reject with an operator-readable message, which the server passes
 * through as the `error` frame the picker renders.
 *
 * The real implementation is `directory-browse.ts`; tests inject a fake. When
 * omitted, both frames answer with an `error` saying browsing is unavailable —
 * a PTY-only Core stays a valid Core, and the Panel's typed-path fallback
 * still validates at project-create time.
 */
export interface CoreDirectoryPort {
  list(requestedPath: string | null | undefined): Promise<CoreLinkDirListing>;
  create(parent: string, name: string): Promise<string>;
}

export interface CoreMutationPort {
  /**
   * Create / rename / archive a project. Returns the resulting snapshot on
   * success; `null` when the mutation targeted a missing row (`rename` /
   * `archive` on an unknown projectId). Throws on invalid input — the server
   * turns thrown errors into an `error` frame with the message.
   */
  mutateProject(mutation: CoreLinkProjectMutation): CoreLinkProjectSnapshot | null;
  /**
   * Create / update a task. Returns the resulting snapshot on success;
   * `null` when `update` targeted a missing row.
   */
  mutateTask(mutation: CoreLinkTaskMutation): CoreLinkTaskSnapshot | null;
  /**
   * Every active session on this Core (optionally filtered to one
   * project). A session is a task-plus-optional-live-PTY: `ptyId` is set
   * when the Core's PTY core currently has a running PTY for that task,
   * `null` otherwise. The Panel uses this to know which sessions it can
   * reattach to on reconnect.
   */
  listSessions(projectId?: string): CoreLinkSessionSnapshot[];
}

export type PtyCoreLinkServerOptions = {
  /** The port to listen on. */
  port: number;
  /** The host to bind to — always 127.0.0.1 for the loopback core-link. */
  host?: string;
  /** Injectable WebSocketServer factory (tests). Default: real `ws.WebSocketServer`. */
  createServer?: (opts: { port: number; host: string; tls?: TlsOptions }) => WebSocketServerLike;
  /**
   * The per-Core event log. When provided, PTY lifecycle events are
   * recorded and the `subscribe`/`event`/`eventsReplayed` replay path is
   * served. When omitted (e.g. tests that only exercise the PTY RPCs),
   * event recording/replay is a no-op and `subscribe` is answered with an
   * empty tail.
   */
  eventLog?: EventLogPort;
  /** Poll interval for live event push after a connection subscribes. */
  liveEventPollMs?: number;
  /**
   * mTLS transport (issue 04, ADR 0002). When set, the default server factory
   * builds a `wss://` server: the Core presents `serverCert`/`serverKey`,
   * pins `caCert`, and requires + verifies a Panel client cert signed by that
   * CA (`requestCert: true, rejectUnauthorized: true`). Loopback dials omit
   * this and stay on `ws://` (trusted). When a custom `createServer` is
   * provided, the tls option is passed through for the factory to use.
   */
  tls?: TlsOptions;
  /**
   * Bearer auth verifier (issue 04). When set, the connection MUST authenticate
   * with an `auth` frame before any other frame is honored — non-auth frames
   * received first are rejected with an `error` and not processed. On a valid
   * bearer the server replies `authOk`; on expiry or bad signature it replies
   * `authError` and closes, so the Panel's existing reconnect path re-dials
   * TLS and re-presents a (reissued) bearer. When omitted (loopback `ws://`,
   * trusted), `auth` is a no-op and all frames are processed as before. When
   * set, the live-event poll (and `subscribe` replay) only start AFTER the
   * connection authenticates — pre-auth, the server holds nothing back.
   */
  authVerifier?: AuthVerifier;
  /**
   * Read-only project + task snapshots for the `projectsList` / `tasksList`
   * frames (issue 07). When omitted, both frames answer with empty results
   * (a PTY-only Core is still a valid Core).
   */
  queryPort?: CoreQueryPort;
  /**
   * Read-write access to project/task rows for the `projectsMutate` /
   * `tasksMutate` / `sessionsList` frames (issue 04, ADR 0004). When omitted,
   * `projectsMutate`/`tasksMutate` return `{ project: null }` /
   * `{ task: null }` and `sessionsList` returns `[]` — matching the pre-04
   * stubs so a PTY-only Core (or a test) still round-trips the frames.
   */
  mutationPort?: CoreMutationPort;
  /**
   * The Core's task-write seam (issue 84). The Core process passes the one it
   * also gives its hook receiver and PTY-exit path, so a Panel-driven write
   * and a hook-driven one are literally the same code on the same ports.
   * Omitted (tests, a PTY-only Core), one is built from the ports above.
   */
  taskWriter?: CoreTaskWriter;
  /**
   * Takes a prompt the Panel captured from the terminal for a harness whose
   * hooks do not report one (issue 84). Omitted, the `harnessPrompt` frame is
   * answered `accepted: false` — a Core with no title generator is still a
   * valid Core.
   */
  promptPort?: { submitted(taskId: string, prompt: string): void };
  /**
   * Snapshot of this Core's CLI availability (issue 11). When omitted, the
   * `agentsAvailabilityList` frame answers with an empty map — the Panel's
   * per-Core availability store then falls back to "checking…" until the
   * next `agents:availabilityChanged` event lands.
   */
  availabilityPort?: HarnessAvailabilityPort;
  /**
   * Installs a missing Harness on this machine when the Panel asks (issue 83).
   * When omitted, `harnessInstall` is answered `accepted: false` with a message
   * — a Core that cannot install is still a valid Core, and the Panel's row
   * goes back to plain `missing` rather than waiting forever.
   */
  installPort?: HarnessInstallPort;
  /**
   * This machine's filesystem, for the Panel's folder picker (web-panel issue
   * 06). When omitted, `dirList` / `dirCreate` answer with an `error` frame
   * saying browsing is unavailable on this Core.
   */
  directoryPort?: CoreDirectoryPort;
  /**
   * The protocol version advertised in the `ready` frame. Defaults to this
   * build's {@link CORE_LINK_PROTOCOL_VERSION} and exists only so a test can
   * stand up a Core that has drifted — the Panel's version gate has nothing
   * else to observe, since a real stale Core is a different build entirely.
   */
  protocolVersion?: string;
};

/**
 * Verifies a presented bearer. Returns `{ ok: true, coreId, exp }` on success,
 * or `{ ok: false, reason }` matching `authError.reason`. The Core wires
 * this with `verifyBearer` from `src/shared/core-link-bearer` and the secret
 * generated at install.
 */
export type AuthVerifier = (
  bearer: string,
) => { ok: true; coreId: string; exp: number } | { ok: false; reason: "expired" | "bad-signature" | "malformed" };

/**
 * mTLS material for the core-link server (issue 04). The Core presents
 * `serverCert`/`serverKey` in the TLS handshake and pins `caCert` so only a
 * Panel holding a client cert signed by that CA gets past the handshake.
 */
export type TlsOptions = {
  /** PEM CA cert that signed the Panel's client cert. Pinned by the server. */
  caCert: string;
  /** PEM server cert presented to the Panel. */
  serverCert: string;
  /** PEM private key for {@link TlsOptions.serverCert}. */
  serverKey: string;
};

export interface WebSocketServerLike {
  close(cb?: () => void): void;
  on(event: "connection", cb: (ws: WebSocketLike) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  /** Pong from the Panel — proof the connection is still alive while idle. */
  on(event: "pong", cb: () => void): void;
  removeAllListeners(): void;
  /** Send a WS ping frame (Node `ws`); absent on injected test fakes. */
  ping?: () => void;
  /** Destroy a half-open socket that will never complete a close handshake. */
  terminate?: () => void;
}

const DEFAULT_LIVE_EVENT_POLL_MS = 500;
const EVENT_TAIL_LIMIT = 1_000;

/**
 * The event-log kind each project mutation op appends. Typed on the op union
 * rather than written as a ternary chain so a new op cannot ship without
 * deciding what a reconnecting Panel replays for it — the compiler asks.
 */
const PROJECT_MUTATION_EVENT_KINDS: Record<CoreLinkProjectMutation["op"], string> = {
  create: "project:created",
  rename: "project:renamed",
  archive: "project:archived",
  pin: "project:pinnedChanged",
  settings: "project:settingsChanged",
  appearance: "project:appearanceChanged",
};
/**
 * Heartbeat cadence, mirroring the Panel-side client. The Core must detect a
 * vanished client too: PTY output fans out to every registered connection, so a
 * half-open one means every chunk an agent produces is written into a socket
 * that will never deliver it — the pane looks frozen while the agent runs on.
 * Pinging every 15s both keeps NATs/firewalls from reaping an idle link and
 * bounds how long a dead connection stays in the registry.
 *
 * The heartbeat is per connection and reaps only its own: with a registry, a
 * connection is stale because *it* has gone quiet, never because a newer one
 * arrived (issue 141).
 */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** Terminate a connection after this long with no message or pong (3 pings). */
const HEARTBEAT_TIMEOUT_MS = 45_000;

/**
 * Hosts the loopback core-link WebSocket server. One instance per Core
 * process. The server outlives individual Panel connections — PTY state is
 * retained in the `PtyCore` across disconnects/reconnects.
 *
 * When an {@link EventLogPort} is provided, every PTY spawn/exit is appended
 * to the monotonic event log, and the `subscribe` frame drives the
 * reconnect-replay path: the Panel sends its `lastEventId`, the server
 * streams the tail as `event` frames, sends an `eventsReplayed` marker, and a
 * per-connection poll loop pushes new events live once caught up.
 */
export class PtyCoreLinkServer {
  private readonly server: WebSocketServerLike;
  private readonly eventLog: EventLogPort | null;
  private readonly liveEventPollMs: number;
  private readonly authVerifier: AuthVerifier | null;
  private readonly queryPort: CoreQueryPort | null;
  private readonly mutationPort: CoreMutationPort | null;
  private readonly availabilityPort: HarnessAvailabilityPort | null;
  private readonly installPort: HarnessInstallPort | null;
  private readonly directoryPort: CoreDirectoryPort | null;
  private readonly promptPort: { submitted(taskId: string, prompt: string): void } | null;
  private readonly protocolVersion: string;
  /**
   * The one seam every task-row change goes through — the Panel's
   * `tasksMutate` frame below and the Core's own writers (hook receiver, PTY
   * exit, title generator) alike, so a row never moves without the event that
   * describes it (issue 84).
   */
  private readonly taskWriter: CoreTaskWriter;
  /**
   * Every core-link connection this Core is currently serving, keyed by its
   * socket (issue 141, ADR 0024 D1). Insertion-ordered, so fan-out reaches
   * clients in the order they connected. Replaces the old `activeWs` +
   * single `connection` pair: a connection's state — auth, cursor, poll,
   * heartbeat — is now the entry, and nothing about it is shared.
   */
  private readonly connections = new Map<WebSocketLike, ActiveConnection>();
  /**
   * True while `core.setEmitTarget` holds this server's fan-out callback. One
   * callback for the whole server, not one per connection — the target is a
   * single global sink on `PtyCore`, so a per-connection one would have the
   * newest connection silently steal every PTY's output from the rest.
   */
  private emitTargetInstalled = false;

  constructor(
    private readonly core: PtyCore,
    opts: PtyCoreLinkServerOptions,
  ) {
    const host = opts.host ?? "127.0.0.1";
    const create = opts.createServer ?? defaultCreateServer;
    this.server = create({ port: opts.port, host, tls: opts.tls });
    this.eventLog = opts.eventLog ?? null;
    this.liveEventPollMs = opts.liveEventPollMs ?? DEFAULT_LIVE_EVENT_POLL_MS;
    this.authVerifier = opts.authVerifier ?? null;
    this.queryPort = opts.queryPort ?? null;
    this.mutationPort = opts.mutationPort ?? null;
    this.availabilityPort = opts.availabilityPort ?? null;
    this.installPort = opts.installPort ?? null;
    this.directoryPort = opts.directoryPort ?? null;
    this.promptPort = opts.promptPort ?? null;
    this.protocolVersion = opts.protocolVersion ?? CORE_LINK_PROTOCOL_VERSION;
    this.taskWriter =
      opts.taskWriter ??
      new CoreTaskWriter({
        mutationPort: this.mutationPort,
        queryPort: this.queryPort,
        eventLog: this.eventLog,
      });
    this.server.on("connection", (ws) => this.onConnection(ws));
    this.server.on("error", (err) => {
      log.error("core-link.server.error", { error: err.message });
    });
  }

  private onConnection(ws: WebSocketLike): void {
    // Many connections at a time (ADR 0024 D1). A new connection — a second
    // Panel tab, the CLI, a reconnecting renderer — is registered alongside
    // whatever is already here, never in place of it. Nothing on `PtyCore`
    // moves as a result.
    const conn = new ActiveConnection(ws);
    this.connections.set(ws, conn);
    this.ensureEmitTarget();

    // Send the ready frame immediately.
    this.send(ws, { type: "ready", version: this.protocolVersion });

    // Start the live-event push poll for this connection. It stays silent
    // until the client sends `subscribe`, then pushes new events past this
    // connection's own lastSentEventId.
    conn.startPoll(() => this.pushLiveEvents(conn), this.liveEventPollMs);

    // Per-connection heartbeat. `lastInboundAt` advances on any frame from the
    // client — an RPC, or the pong answering our ping — so a connection only
    // dies here when that client is genuinely unreachable. The registry
    // membership check is the liveness question now: asking whether some other
    // socket is "the active one" would reap healthy connections the moment a
    // second client arrived.
    if (ws.ping) {
      conn.heartbeat = setInterval(() => {
        if (this.connections.get(ws) !== conn) {
          conn.stopHeartbeat();
          return;
        }
        const idleMs = Date.now() - conn.lastInboundAt;
        if (idleMs > HEARTBEAT_TIMEOUT_MS) {
          conn.stopHeartbeat();
          log.warn("core-link.connection.stale", { idleMs });
          try {
            ws.terminate ? ws.terminate() : ws.close();
          } catch {
            /* already gone — the close handler still runs */
          }
          return;
        }
        try {
          ws.ping?.();
        } catch {
          /* the close handler will take it from here */
        }
      }, HEARTBEAT_INTERVAL_MS);
      if (typeof conn.heartbeat.unref === "function") conn.heartbeat.unref();
    }
    ws.on("pong", () => {
      conn.lastInboundAt = Date.now();
    });

    ws.on("message", (raw) => {
      conn.lastInboundAt = Date.now();
      this.onMessage(conn, raw);
    });
    ws.on("close", () => {
      this.dropConnection(ws, conn);
    });
    ws.on("error", (err) => {
      log.warn("core-link.connection.error", { error: err.message });
    });
  }

  /**
   * Retire one connection: its poll timer and its heartbeat, and nothing
   * else. Every other connection keeps its own — the defect this replaces
   * cancelled a shared poll, so one client closing stopped live event push for
   * whoever else was here. The emit target is released only when the last
   * connection goes, which is what makes a Core with no clients quiet again.
   */
  private dropConnection(ws: WebSocketLike, conn: ActiveConnection): void {
    conn.stopHeartbeat();
    conn.stopPoll();
    // Guard on identity, not presence: a socket that was already replaced in
    // the map must not evict its successor.
    if (this.connections.get(ws) === conn) this.connections.delete(ws);
    if (this.connections.size === 0) this.releaseEmitTarget();
  }

  /**
   * Install this server's single PTY-event sink on the Core, once.
   *
   * **Interim behaviour (issue 141):** every registered connection receives
   * every PTY's `data` and `exit`. Per-connection subscription is D2 and lands
   * in its own ticket; until then a fan-out is the only correct stopgap, since
   * `PtyCore.setEmitTarget` holds exactly one callback and setting it per
   * connection would leave the *first* client silent while it still looked
   * healthy — no close, no error, just no output.
   */
  private ensureEmitTarget(): void {
    if (this.emitTargetInstalled) return;
    this.emitTargetInstalled = true;
    this.core.setEmitTarget((event) => this.fanOutPtyEvent(event));
  }

  private releaseEmitTarget(): void {
    if (!this.emitTargetInstalled) return;
    this.emitTargetInstalled = false;
    this.core.setEmitTarget(null);
  }

  /**
   * Deliver one PTY event to every *authenticated* connection, and record an
   * exit exactly once. The event log is a fact about the machine, not about who
   * was watching: appending per connection would write two `pty:exit` rows for
   * one dead process and replay the exit twice to every reconnecting client —
   * so the append stays outside the loop, and a connection being skipped never
   * costs the log a row.
   *
   * The auth skip mirrors `pushLiveEvents`: with an `authVerifier` configured,
   * a connection that has not proved identity gets nothing pushed at it. PTY
   * output is strictly more sensitive than the event timeline, and a socket
   * that presents no bearer and sends no frame never trips the message gate —
   * answering pings keeps `lastInboundAt` fresh, so the heartbeat never reaps
   * it either. Until this ticket the fan-out was the one push path that did not
   * ask. Loopback Cores configure no verifier, where `authenticated` is
   * irrelevant and every connection is served exactly as before.
   */
  private fanOutPtyEvent(event: PtyCoreEvent): void {
    const frame: CoreLinkServerFrame =
      event.type === "data"
        ? { type: "data", ptyId: event.ptyId, data: event.data, seq: event.seq }
        : { type: "exit", ptyId: event.ptyId, exitCode: event.exitCode, signal: event.signal };
    for (const conn of this.connections.values()) {
      if (this.authVerifier && !conn.authenticated) continue;
      this.send(conn.ws, frame);
    }
    if (event.type === "exit") {
      this.recordPtyExit(event);
    }
  }

  /** Record a pty:exit event in the log (lifecycle marker for replay). */
  private recordPtyExit(event: { ptyId: string; exitCode: number; signal?: number }): void {
    if (!this.eventLog) return;
    const payload = JSON.stringify({ exitCode: event.exitCode, signal: event.signal });
    this.eventLog.appendEvent("pty:exit", payload, { ptyId: event.ptyId });
  }

  /**
   * Record a project mutation in the event log so a reconnecting Panel learns
   * about the change via the same `subscribe` / `event` / `eventsReplayed`
   * replay path the PTY lifecycle events use (issue 04). Kinds mirror the
   * server's AppEvent names (`project:created`, `project:updated`,
   * `project:archived`, plus the dedicated `project:pinnedChanged` /
   * `project:settingsChanged` / `project:appearanceChanged`) so the Panel can
   * route by kind without a translation layer. Only successful mutations are
   * recorded — a `null` result (row missing) does not append.
   */
  private recordProjectMutation(
    mutation: CoreLinkProjectMutation,
    project: CoreLinkProjectSnapshot,
  ): void {
    if (!this.eventLog) return;
    const kind = PROJECT_MUTATION_EVENT_KINDS[mutation.op];
    const payload = JSON.stringify({ projectId: project.projectId });
    this.eventLog.appendEvent(kind, payload, { taskId: null, ptyId: null });
  }


  /**
   * Record a pty:spawn event in the log (lifecycle marker for replay). The
   * `shellSession` flag (issue 06) is carried in the payload so a reconnecting
   * Panel can distinguish a VM Shell Session spawn from an agent/session spawn
   * when replaying the event tail — and render it with the distinct "VM shell"
   * surface instead of reattaching as an agent workspace.
   */
  private recordPtySpawn(ptyId: string, taskId: string, shellSession = false): void {
    if (!this.eventLog) return;
    const payload = JSON.stringify({ ptyId, taskId, shellSession });
    this.eventLog.appendEvent("pty:spawn", payload, { ptyId, taskId });
  }

  /**
   * Push any events appended after the connection's lastSentEventId. Runs on
   * the poll loop once the connection has subscribed. Also advances the
   * connection cursor so the next tick only sees newer events.
   */
  private pushLiveEvents(conn: ActiveConnection): void {
    if (!conn.subscribed || !this.eventLog) return;
    // When auth is required, never push events until authenticated — a
    // pre-auth subscriber would learn the event timeline without proving
    // identity. Per connection: one authenticated client does not open the
    // stream for another that has not authenticated.
    if (this.authVerifier && !conn.authenticated) return;
    const after = conn.lastSentEventId;
    const tail = this.eventLog.readEventTail(after, EVENT_TAIL_LIMIT);
    for (const event of tail) {
      this.send(conn.ws, { type: "event", event });
      conn.lastSentEventId = event.eventId;
    }
  }

  private async onMessage(conn: ActiveConnection, raw: unknown): Promise<void> {
    const ws = conn.ws;
    const data = typeof raw === "string" ? raw : String(raw);
    const frame = parseCoreLinkRequestFrame(data);
    if (!frame) {
      this.send(ws, { type: "error", message: "invalid frame" });
      return;
    }
    // ─── Bearer auth gate (issue 04) ───
    // `auth` is always processed (it's how the connection authenticates). Any
    // other frame received before authentication, when an `authVerifier` is
    // configured, is rejected — the Panel must present its bearer first.
    if (frame.type !== "auth" && this.authVerifier && !conn.authenticated) {
      this.send(ws, { type: "error", reqId: frame.reqId, message: "not-authenticated" });
      // Drop the connection so the Panel's reconnect path re-presents `auth`
      // from a clean state instead of racing frames.
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      return;
    }
    try {
      await this.dispatch(conn, frame);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(ws, { type: "error", reqId: frame.reqId, message });
    }
  }

  /**
   * The filesystem port, or `null` after telling the Panel there isn't one.
   * A Core wired without it is still a valid Core; the Panel's typed-path
   * fallback keeps working, since project paths are validated on create.
   */
  private requireDirectoryPort(ws: WebSocketLike, reqId: string): CoreDirectoryPort | null {
    if (this.directoryPort) return this.directoryPort;
    this.send(ws, {
      type: "error",
      reqId,
      message: "Folder browsing is unavailable on this Core",
    });
    return null;
  }

  private async dispatch(conn: ActiveConnection, frame: CoreLinkRequestFrame): Promise<void> {
    const ws = conn.ws;
    switch (frame.type) {
      case "spawn": {
        try {
          const { ptyId, hooksReportTurnStart } = await this.core.spawn(frame.opts);
          // `shellSession` is the VM Shell Session discriminant (issue 06):
          // `true` on the VM-shell variant, `never` (undefined) on the
          // agent/shell variants. The type-safe narrow records which surface
          // the Panel should render into the pty:spawn event payload, so a
          // reconnecting Panel can distinguish a VM-shell spawn from an
          // agent/session spawn when replaying the event tail.
          const shellSession = frame.opts.shellSession === true;
          this.recordPtySpawn(ptyId, frame.opts.taskId, shellSession);
          // `hooksReportTurnStart` is what lets the Panel arm its
          // terminal-input fallback on reality rather than on the harness
          // family (issue 84): a Session whose hooks will not announce the
          // start of a turn has no other `running` signal.
          this.send(ws, { type: "spawned", reqId: frame.reqId, ptyId, hooksReportTurnStart });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.send(ws, { type: "spawnError", reqId: frame.reqId, message });
        }
        return;
      }
      case "write": {
        const ok = this.core.write(frame.ptyId, frame.data);
        this.send(ws, { type: "writeResult", reqId: frame.reqId, ok });
        return;
      }
      case "resize": {
        const ok = this.core.resize(frame.ptyId, frame.cols, frame.rows);
        this.send(ws, { type: "resizeResult", reqId: frame.reqId, ok });
        return;
      }
      case "kill": {
        const ok = this.core.kill(frame.ptyId);
        this.send(ws, { type: "killResult", reqId: frame.reqId, ok });
        return;
      }
      case "killLaunchProcesses": {
        const result = await this.core.killLaunchProcesses({
          cwd: frame.cwd,
          commands: frame.commands,
          ports: frame.ports,
        });
        const linkResult: CoreLinkLaunchProcessKillResult = {
          ptyCount: result.ptyCount,
          ports: result.ports,
        };
        this.send(ws, {
          type: "killLaunchProcessesResult",
          reqId: frame.reqId,
          result: linkResult,
        });
        return;
      }
      case "findByTask": {
        const { ptyId } = this.core.findByTask(frame.taskId);
        this.send(ws, { type: "findByTaskResult", reqId: frame.reqId, ptyId });
        return;
      }
      case "replay": {
        const result = this.core.replay(frame.ptyId, frame.sinceSeq);
        this.send(ws, {
          type: "replayResult",
          reqId: frame.reqId,
          data: result.data,
          nextSeq: result.nextSeq,
          from: result.from,
        });
        return;
      }
      case "subscribe": {
        // Auth gate (re-checked here so a hand-rolled `subscribe` after auth
        // still works, but a pre-auth `subscribe` slipped past the message
        // gate is rejected rather than silently streaming the event tail).
        if (this.authVerifier && !conn.authenticated) {
          this.send(ws, { type: "error", reqId: frame.reqId, message: "not-authenticated" });
          return;
        }
        this.handleSubscribe(conn, frame);
        return;
      }
      case "auth": {
        this.handleAuth(conn, frame);
        return;
      }
      // ─── Task / project / session / hook ops (issue 02 schema + issue 07
      // wiring). Task + project ops delegate to the CoreQueryPort so the
      // Panel renders live snapshots with no Panel-side persistence. When no
      // queryPort is configured (a PTY-only Core, or tests), both answer
      // with empty results so the Panel can round-trip them without errors.
      case "tasksList": {
        const tasks = this.queryPort ? this.queryPort.listTasks(frame.projectId) : [];
        // The count of archived rows, never the rows — see ADR 0019. It rides
        // this answer because the Panel needs it continuously (to gate and
        // label the Archived tab), while the rows are wanted only when that
        // view is open, over `archivedTasksList`.
        const archivedCount = this.queryPort
          ? this.queryPort.countArchivedTasks(frame.projectId)
          : 0;
        this.send(ws, { type: "tasksListResult", reqId: frame.reqId, tasks, archivedCount });
        return;
      }
      case "archivedTasksList": {
        const tasks = this.queryPort ? this.queryPort.listArchivedTasks(frame.projectId) : [];
        this.send(ws, { type: "archivedTasksListResult", reqId: frame.reqId, tasks });
        return;
      }
      case "projectsList": {
        const projects = this.queryPort ? this.queryPort.listProjects() : [];
        this.send(ws, { type: "projectsListResult", reqId: frame.reqId, projects });
        return;
      }
      case "tasksMutate": {
        if (!this.mutationPort) {
          this.send(ws, { type: "tasksMutateResult", reqId: frame.reqId, task: null });
          return;
        }
        try {
          // The Panel's write and the Core's own writes (hooks, PTY exit, the
          // title generator) share one seam, so the row and the events that
          // describe it never come apart (issue 84).
          const task = this.taskWriter.mutate(frame.mutation);
          this.send(ws, { type: "tasksMutateResult", reqId: frame.reqId, task });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.send(ws, { type: "error", reqId: frame.reqId, message });
        }
        return;
      }
      case "harnessPrompt": {
        // The Panel read this off the terminal because the harness's hooks
        // will not report it. Nothing is patched here; the Core decides on
        // its own whether the Session wants naming.
        const accepted = Boolean(this.promptPort && frame.taskId && frame.prompt?.trim());
        if (accepted) this.promptPort!.submitted(frame.taskId, frame.prompt);
        this.send(ws, { type: "harnessPromptResult", reqId: frame.reqId, accepted });
        return;
      }
      case "projectsMutate": {
        if (!this.mutationPort) {
          this.send(ws, { type: "projectsMutateResult", reqId: frame.reqId, project: null });
          return;
        }
        try {
          const project = this.mutationPort.mutateProject(frame.mutation);
          if (project) this.recordProjectMutation(frame.mutation, project);
          this.send(ws, { type: "projectsMutateResult", reqId: frame.reqId, project });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.send(ws, { type: "error", reqId: frame.reqId, message });
        }
        return;
      }
      case "sessionsList": {
        const sessions = this.mutationPort
          ? this.mutationPort.listSessions(frame.projectId)
          : [];
        this.send(ws, { type: "sessionsListResult", reqId: frame.reqId, sessions });
        return;
      }
      case "hooksOp": {
        this.send(ws, { type: "hooksOpResult", reqId: frame.reqId, hooks: [] });
        return;
      }
      case "agentsAvailabilityList": {
        // Issue 11: snapshot answer for the fresh-Panel hydration path. The
        // event stream (`agents:availabilityChanged`) carries deltas for a
        // subscribed Panel; this frame gets a Panel that just mounted the
        // per-Core availability hook off the ground without waiting for the
        // next probe tick.
        const availability = this.availabilityPort
          ? this.availabilityPort.snapshot()
          : {};
        this.send(ws, {
          type: "agentsAvailabilityListResult",
          reqId: frame.reqId,
          availability,
        });
        return;
      }
      case "harnessInstall": {
        // Issue 83: ack, then install. Never `await` the install here — a
        // vendor installer runs for minutes, the Panel's request timeout is
        // 30s, and this connection has every other frame to go on serving. The
        // outcome reaches the Panel on the event log: `available` from the
        // re-probe, or `harness:installFailed`.
        this.startHarnessInstall(ws, frame.reqId, frame.harness);
        return;
      }
      // ─── Folder picker (web-panel issue 06) ───
      // The Panel is a browser: the machine whose folders matter is this one,
      // and nothing else can enumerate it. Errors are thrown by the port with
      // the message the operator should read and travel back as `error`.
      case "dirList": {
        const port = this.requireDirectoryPort(ws, frame.reqId);
        if (!port) return;
        const listing = await port.list(frame.path);
        this.send(ws, { type: "dirListResult", reqId: frame.reqId, listing });
        return;
      }
      case "dirCreate": {
        const port = this.requireDirectoryPort(ws, frame.reqId);
        if (!port) return;
        const created = await port.create(frame.parent, frame.name);
        this.send(ws, { type: "dirCreateResult", reqId: frame.reqId, path: created });
        return;
      }
    }
    // Exhaustive switch — if a new frame type is added to CoreLinkRequestFrame
    // without a case here, TypeScript flags this unreachable line.
    this.send(ws, { type: "error", message: `unhandled frame type: ${(frame as { type: string }).type}` });
  }

  /**
   * Acknowledge a `harnessInstall` request and start the install behind it
   * (issue 83).
   *
   * The ack is the whole answer to the request: it says the Core took the job,
   * never how the job went. What comes back later comes back on the event log,
   * which is what makes an install survive a Panel reload, a link drop, and a
   * second tab watching the same Core — none of which a pending promise does.
   *
   * A refusal (`accepted: false`) is for an install that will not happen at
   * all: an id this Core does not know, or a Core wired with no install port.
   * The Panel returns the row to plain `missing` so it can be retried.
   */
  private startHarnessInstall(ws: WebSocketLike, reqId: string, harnessId: string): void {
    const port = this.installPort;
    if (!port) {
      this.send(ws, {
        type: "harnessInstallAck",
        reqId,
        accepted: false,
        message: "This Core cannot install Harnesses.",
      });
      return;
    }
    if (!port.installable(harnessId)) {
      this.send(ws, {
        type: "harnessInstallAck",
        reqId,
        accepted: false,
        message: `Actana does not know how to install \`${harnessId}\`.`,
      });
      return;
    }
    this.send(ws, { type: "harnessInstallAck", reqId, accepted: true });

    void port
      .install(harnessId)
      .then((result) => {
        if (result.ok) return;
        this.publishHarnessInstallFailure(harnessId, result.message);
      })
      .catch((err: unknown) => {
        // The port promises not to throw; if it does, the Panel still gets a
        // verdict rather than a row stuck installing forever.
        this.publishHarnessInstallFailure(
          harnessId,
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  /**
   * Append the one definitive install failure the Panel acts on. It rides the
   * event log rather than the availability map on purpose: an availability
   * entry is a fact about PATH that the next probe overwrites, and a failure
   * cached there would outlive its own truth and disable the Harness for good.
   */
  private publishHarnessInstallFailure(harnessId: string, message?: string): void {
    const payload: CoreLinkHarnessInstallFailedPayload = {
      harness: harnessId,
      message: message || `Installing ${harnessId} on this Core failed.`,
    };
    log.warn("core-link.harness-install.failed", payload);
    try {
      this.eventLog?.appendEvent(HARNESS_INSTALL_FAILED_EVENT_KIND, JSON.stringify(payload), {
        ptyId: null,
        taskId: null,
      });
    } catch (err) {
      log.warn("core-link.harness-install.append-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle a `subscribe` frame: stream the event_log tail past the Panel's
   * `lastEventId` as `event` frames, then send `eventsReplayed` with the new
   * cursor. The per-connection poll loop takes over live push from here.
   * When no event log is configured, reply with an empty tail + the same
   * cursor so the Panel's state machine stays consistent.
   */
  private handleSubscribe(
    conn: ActiveConnection,
    frame: { type: "subscribe"; reqId: string; lastEventId: number },
  ): void {
    const ws = conn.ws;
    conn.subscribed = true;
    const fromEventId = frame.lastEventId;
    let lastSent = fromEventId;
    const tail = this.eventLog
      ? this.eventLog.readEventTail(fromEventId, EVENT_TAIL_LIMIT)
      : [];
    this.send(ws, { type: "subscribeAck", reqId: frame.reqId, fromEventId });
    for (const event of tail) {
      this.send(ws, { type: "event", event });
      lastSent = event.eventId;
    }
    conn.lastSentEventId = lastSent;
    this.send(ws, { type: "eventsReplayed", lastEventId: lastSent });
  }

  /**
   * Handle an `auth` frame (issue 04). Verifies the bearer; on success marks
   * the connection authenticated and replies `authOk` (carrying `exp` so the
   * Panel can hint "session expires at"). On failure replies `authError` and
   * closes — the Panel's existing reconnect path re-handshakes TLS and
   * re-presents a (reissued) bearer, replaying missed events via `lastEventId`.
   *
   * When no `authVerifier` is configured (loopback `ws://`, trusted) the
   * `auth` frame is rejected — the loopback Panel never sends one.
   */
  private handleAuth(
    conn: ActiveConnection,
    frame: { type: "auth"; reqId: string; bearer: string },
  ): void {
    const ws = conn.ws;
    if (!this.authVerifier) {
      this.send(ws, {
        type: "authError",
        reqId: frame.reqId,
        reason: "malformed",
      });
      return;
    }
    const result = this.authVerifier(frame.bearer);
    if (!result.ok) {
      this.send(ws, { type: "authError", reqId: frame.reqId, reason: result.reason });
      // Close so the Panel's reconnect path takes over. The close handler
      // drops this connection from the registry; a fresh `auth` lands on a
      // fresh one, and every other client's authentication is unaffected.
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      return;
    }
    conn.authenticated = true;
    this.send(ws, {
      type: "authOk",
      reqId: frame.reqId,
      coreId: result.coreId,
      exp: result.exp,
    });
  }

  private send(ws: WebSocketLike, frame: CoreLinkServerFrame): void {
    try {
      ws.send(serializeCoreLinkFrame(frame));
    } catch {
      /* connection closed mid-send — the close handler will clean up */
    }
  }

  /**
   * Shut the server down, disarming every socket it is still serving.
   *
   * Dropping the registry is not enough: the `message` handler closes over its
   * own {@link ActiveConnection}, not over `this.connections`, so a frame
   * arriving after shutdown would still be dispatched in full — `spawn` and
   * `kill` included — on a connection whose `authenticated` is still true.
   * Before issue 141 `close()` nulled the single `connection` field and the
   * auth gate went false with it; with a registry, the socket itself has to be
   * taken out of the conversation. Removing the listeners is what actually does
   * that — a close handshake still delivers whatever is already in flight — and
   * the `close()` that follows is the polite half, telling the client this Core
   * is going away rather than leaving it to notice a dead socket.
   */
  close(): void {
    for (const conn of [...this.connections.values()]) {
      conn.stopHeartbeat();
      conn.stopPoll();
      try {
        conn.ws.removeAllListeners();
        conn.ws.close();
      } catch {
        /* already gone — nothing left to disarm */
      }
    }
    this.connections.clear();
    this.releaseEmitTarget();
    this.server.close();
  }
}

/**
 * One core-link connection's own state: whether it has authenticated, whether
 * it has subscribed, the highest eventId it has been sent, its live-event poll
 * and its heartbeat. Every field here is private to one client — this shape
 * always was per-connection; before issue 141 it was simply only ever
 * instantiated once, and the server held the socket beside it.
 *
 * Nothing about a Session, a PTY or the event log lives here. Those are Core
 * facts, shared by construction, and a connection arriving or leaving must not
 * move any of them.
 */
class ActiveConnection {
  subscribed = false;
  /** True once an `auth` frame has been verified (issue 04). Always true for
   *  loopback (no `authVerifier` configured). */
  authenticated = false;
  lastSentEventId = 0;
  /** Last time anything arrived from this client — a frame, or a pong. */
  lastInboundAt = Date.now();
  /** This connection's ping timer; only it may reap this connection. */
  heartbeat: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly ws: WebSocketLike) {}

  startPoll(fn: () => void, intervalMs: number): void {
    this.stopPoll();
    this.timer = setInterval(fn, intervalMs);
    // Unref so the timer never keeps the Core process alive on shutdown.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stopPoll(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}

function defaultCreateServer(opts: {
  port: number;
  host: string;
  tls?: TlsOptions;
}): WebSocketServerLike {
  // Lazy require so this module stays importable in tests without `ws` at
  // import time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebSocketServer } = require("ws") as typeof import("ws");
  if (opts.tls) {
    // mTLS server (issue 04, ADR 0002): present the server cert, pin the CA,
    // and require + verify a Panel client cert signed by that CA. A Panel
    // without the pinned client cert never gets past the handshake.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const https = require("node:https") as typeof import("node:https");
    const tlsServer = https.createServer({
      cert: opts.tls.serverCert,
      key: opts.tls.serverKey,
      ca: opts.tls.caCert,
      requestCert: true,
      rejectUnauthorized: true,
      // Disable Nagle on accepted sockets. PTY output is a stream of small
      // writes; coalescing them against the Panel's delayed ACKs adds tens of
      // ms of jitter to every repaint. Set explicitly rather than relying on
      // the runtime's default.
      noDelay: true,
    });
    tlsServer.listen(opts.port, opts.host);
    const wss = new WebSocketServer({ server: tlsServer });
    return {
      close: (cb) => {
        wss.close(() => tlsServer.close(cb));
      },
      on: (event, cb) => {
        if (event === "connection") {
          wss.on("connection", (ws: WebSocket) => {
            (cb as (ws: WebSocketLike) => void)(adaptWs(ws));
          });
        } else if (event === "error") {
          wss.on("error", (err: Error) => (cb as (err: Error) => void)(err));
        }
      },
    };
  }
  const wss = new WebSocketServer({ port: opts.port, host: opts.host });
  return {
    close: (cb) => wss.close(cb),
    on: (event, cb) => {
      if (event === "connection") {
        wss.on("connection", (ws: WebSocket) => {
          (cb as (ws: WebSocketLike) => void)(adaptWs(ws));
        });
      } else if (event === "error") {
        wss.on("error", (err: Error) => (cb as (err: Error) => void)(err));
      }
    },
  };
}

/** Adapt a `ws.WebSocket` to the transport-agnostic `WebSocketLike` interface. */
function adaptWs(ws: WebSocket): WebSocketLike {
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    ping: () => {
      try {
        ws.ping();
      } catch {
        /* socket already closing — the close handler covers it */
      }
    },
    terminate: () => ws.terminate(),
    on: (event, cb) => {
      if (event === "message") {
        ws.on("message", (data: unknown) => (cb as (data: unknown) => void)(data));
      } else if (event === "close") {
        ws.on("close", () => (cb as () => void)());
      } else if (event === "error") {
        ws.on("error", (err: Error) => (cb as (err: Error) => void)(err));
      } else if (event === "pong") {
        ws.on("pong", () => (cb as () => void)());
      }
    },
    removeAllListeners: () => ws.removeAllListeners(),
  };
}
