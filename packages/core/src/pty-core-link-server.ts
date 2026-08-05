// WebSocket server for the loopback core-link.
//
// Hosts a `ws.WebSocketServer` on `ws://127.0.0.1:<port>` and wires incoming
// frames to a `PtyCore`. The Core process (core-runner.mjs) loads
// this alongside the core; the Panel service never imports this module.
//
// Loopback-only (trusted) — no auth yet. A later issue adds mTLS + bearer auth
// before the same server listens on a non-loopback interface.
//
// A single connection is expected at a time (the Panel). When the Panel
// disconnects (renderer reload, app sleep), `core.setEmitTarget(null)` stops
// output delivery — the PTY buffer retains everything for replay on reconnect.

import log from "./log";
import type { WebSocketServer, WebSocket } from "ws";
import {
  CORE_LINK_PROTOCOL_VERSION,
  parseCoreLinkRequestFrame,
  serializeCoreLinkFrame,
  type CoreLinkHarnessAvailabilityMap,
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
import type { TaskStatus } from "@actana/shared/domain";
import type { PtyCore } from "./pty-manager";

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
   * Every task on this Core (optionally filtered to one project). The
   * Core omits archived tasks — the Fleet view is for active work, and the
   * Panel caches nothing, so archived rows never cross the core-link.
   */
  listTasks(projectId?: string): CoreLinkTaskSnapshot[];
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
   * Snapshot of this Core's CLI availability (issue 11). When omitted, the
   * `agentsAvailabilityList` frame answers with an empty map — the Panel's
   * per-Core availability store then falls back to "checking…" until the
   * next `agents:availabilityChanged` event lands.
   */
  availabilityPort?: HarnessAvailabilityPort;
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
 * Heartbeat cadence, mirroring the Panel-side client. The Core must detect a
 * vanished Panel too: `setEmitTarget` points PTY output at whatever socket is
 * active, so a half-open connection means every chunk an agent produces is
 * written into a socket that will never deliver it — the pane looks frozen
 * while the agent runs on. Pinging every 15s both keeps NATs/firewalls from
 * reaping an idle link and bounds how long a dead one can hold the emit target.
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
  private readonly directoryPort: CoreDirectoryPort | null;
  private readonly protocolVersion: string;
  private activeWs: WebSocketLike | null = null;
  private connection: ActiveConnection | null = null;

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
    this.directoryPort = opts.directoryPort ?? null;
    this.protocolVersion = opts.protocolVersion ?? CORE_LINK_PROTOCOL_VERSION;
    this.server.on("connection", (ws) => this.onConnection(ws));
    this.server.on("error", (err) => {
      log.error("core-link.server.error", { error: err.message });
    });
  }

  private onConnection(ws: WebSocketLike): void {
    // One connection at a time. If the Panel reconnects (renderer reload),
    // drop the old connection first — the core's PTY state survives.
    if (this.activeWs) {
      try {
        this.activeWs.removeAllListeners();
        this.activeWs.close();
      } catch {
        /* already closed */
      }
    }
    this.activeWs = ws;
    this.connection = new ActiveConnection();

    // Wire core events → outgoing frames. PTY exit events are also appended
    // to the event log (pty:exit lifecycle marker) so a reconnecting Panel
    // learns which PTYs died while it was away.
    this.core.setEmitTarget((event) => {
      const frame: CoreLinkServerFrame =
        event.type === "data"
          ? { type: "data", ptyId: event.ptyId, data: event.data, seq: event.seq }
          : { type: "exit", ptyId: event.ptyId, exitCode: event.exitCode, signal: event.signal };
      this.send(ws, frame);
      if (event.type === "exit") {
        this.recordPtyExit(event);
      }
    });

    // Send the ready frame immediately.
    this.send(ws, { type: "ready", version: this.protocolVersion });

    // Start the live-event push poll for this connection. It stays silent
    // until the Panel sends `subscribe`, then pushes new events past the
    // connection's lastSentEventId.
    this.connection.startPoll(() => this.pushLiveEvents(ws), this.liveEventPollMs);

    // Per-connection heartbeat. `lastInboundAt` advances on any frame from the
    // Panel — an RPC, or the pong answering our ping — so a connection only
    // dies here when the Panel is genuinely unreachable.
    let lastInboundAt = Date.now();
    const heartbeat = ws.ping
      ? setInterval(() => {
          if (this.activeWs !== ws) {
            clearInterval(heartbeat!);
            return;
          }
          if (Date.now() - lastInboundAt > HEARTBEAT_TIMEOUT_MS) {
            clearInterval(heartbeat!);
            log.warn("core-link.connection.stale", { idleMs: Date.now() - lastInboundAt });
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
        }, HEARTBEAT_INTERVAL_MS)
      : null;
    ws.on("pong", () => {
      lastInboundAt = Date.now();
    });

    ws.on("message", (raw) => {
      lastInboundAt = Date.now();
      this.onMessage(ws, raw);
    });
    ws.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      if (this.activeWs === ws) {
        this.activeWs = null;
        this.core.setEmitTarget(null);
      }
      if (this.connection) {
        this.connection.stopPoll();
        this.connection = null;
      }
    });
    ws.on("error", (err) => {
      log.warn("core-link.connection.error", { error: err.message });
    });
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
   * `project:settingsChanged`) so the Panel can route by kind without a translation
   * layer. Only successful mutations are recorded — a `null` result (row
   * missing) does not append.
   */
  private recordProjectMutation(
    mutation: CoreLinkProjectMutation,
    project: CoreLinkProjectSnapshot,
  ): void {
    if (!this.eventLog) return;
    const kind =
      mutation.op === "create"
        ? "project:created"
        : mutation.op === "rename"
          ? "project:renamed"
          : mutation.op === "pin"
            ? "project:pinnedChanged"
            : mutation.op === "settings"
              ? "project:settingsChanged"
              : "project:archived";
    const payload = JSON.stringify({ projectId: project.projectId });
    this.eventLog.appendEvent(kind, payload, { taskId: null, ptyId: null });
  }

  /**
   * Record a task mutation in the event log (see {@link recordProjectMutation}).
   *
   * On `update`, the kind depends on which fields the frame carried:
   *  - `icon` set (with no other patched field) → `task:iconChanged` — the
   *    Panel's live query wants to route icon-only edits distinctly from other
   *    task updates so a reconnecting Panel replays the change through the
   *    existing `subscribe`/`event`/`eventsReplayed` path (issue 09).
   *  - `pinned` set (with no other patched field) → `task:pinnedChanged` —
   *    same rationale as icon (issue 10). Pin toggles are frequent and
   *    consumers that only track pinned state (e.g. the SessionGrid pinned
   *    filter) can subscribe distinctly.
   *  - anything else → `task:updated` (unchanged).
   *
   * On `create`, the kind is always `task:created` — a new row's icon is part
   * of the initial snapshot the tasks list carries, not a discrete change.
   *
   * A transition into `finished` additionally appends `session:finished`
   * (issue 20) — the event ADR 0008 built the Panel's notification on and no
   * Core ever produced. It is additional, not a replacement: the live query
   * still needs the `task:updated` event for the same mutation.
   */
  private recordTaskMutation(
    mutation: CoreLinkTaskMutation,
    task: CoreLinkTaskSnapshot,
    previousStatus: string | null,
  ): void {
    if (!this.eventLog) return;
    const kind =
      mutation.op === "create"
        ? "task:created"
        : isIconOnlyUpdate(mutation)
          ? "task:iconChanged"
          : isPinnedOnlyUpdate(mutation)
            ? "task:pinnedChanged"
            : "task:updated";
    const payload = JSON.stringify({ taskId: task.taskId, projectId: task.projectId });
    this.eventLog.appendEvent(kind, payload, { taskId: task.taskId });
    this.recordSessionFinish(mutation, task, previousStatus);
  }

  /**
   * Append `session:finished` when a mutation moved a task into `finished` —
   * and only then. Two things have to hold, and both are load-bearing.
   *
   * The mutation must be the one that set the status: the resulting snapshot
   * alone would say `finished` for every later write to the same row, so
   * archiving, pinning, or renaming a finished Session — the most routine
   * things to do with one — would each raise a fresh notification.
   *
   * And the row must not have been finished already, so a retried exit patch
   * or a second tab racing the first cannot raise a second notification. That
   * is what the prior status is for; the snapshot cannot tell the two apart.
   *
   * The payload carries what the Panel's finish normalizer reads: the task id
   * (as `id`, its preferred key), the project id, the project name, and the
   * task title. Without the last two the toast reads "Project" / "Session",
   * which is the degraded output this event exists to avoid. The project name
   * is the one field not on the task snapshot; it is read through the query
   * port, and omitted when no query port is wired (a PTY-only Core).
   */
  private recordSessionFinish(
    mutation: CoreLinkTaskMutation,
    task: CoreLinkTaskSnapshot,
    previousStatus: string | null,
  ): void {
    if (!this.eventLog) return;
    if (!patchesFinishedStatus(mutation)) return;
    if (task.status !== FINISHED_TASK_STATUS) return;
    if (previousStatus === FINISHED_TASK_STATUS) return;
    const projectName = this.queryPort
      ?.listProjects()
      .find((p) => p.projectId === task.projectId)?.name;
    const payload = JSON.stringify({
      id: task.taskId,
      taskId: task.taskId,
      projectId: task.projectId,
      ...(projectName ? { projectName } : {}),
      taskTitle: task.title,
    });
    this.eventLog.appendEvent("session:finished", payload, { taskId: task.taskId });
  }

  /**
   * The status a task carried before a mutation is applied, or `null` when
   * there is nothing to read — an unknown row, a Core with no query port, or
   * a mutation that could not produce a finish. Only a patch that could pays
   * for the read; nothing else consults the prior status.
   */
  private priorTaskStatus(mutation: CoreLinkTaskMutation): string | null {
    if (!patchesFinishedStatus(mutation)) return null;
    return this.queryPort?.getTask(mutation.taskId)?.status ?? null;
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
  private pushLiveEvents(ws: WebSocketLike): void {
    if (!this.connection || !this.connection.subscribed || !this.eventLog) return;
    // When auth is required, never push events until authenticated — a
    // pre-auth subscriber would learn the event timeline without proving
    // identity.
    if (this.authVerifier && !this.connection.authenticated) return;
    const after = this.connection.lastSentEventId;
    const tail = this.eventLog.readEventTail(after, EVENT_TAIL_LIMIT);
    for (const event of tail) {
      this.send(ws, { type: "event", event });
      this.connection.lastSentEventId = event.eventId;
    }
  }

  private async onMessage(ws: WebSocketLike, raw: unknown): Promise<void> {
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
    if (frame.type !== "auth" && this.authVerifier && !this.isAuthenticated()) {
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
      await this.dispatch(ws, frame);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(ws, { type: "error", reqId: frame.reqId, message });
    }
  }

  private isAuthenticated(): boolean {
    return this.connection?.authenticated ?? false;
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

  private async dispatch(ws: WebSocketLike, frame: CoreLinkRequestFrame): Promise<void> {
    switch (frame.type) {
      case "spawn": {
        try {
          const { ptyId } = await this.core.spawn(frame.opts);
          // `shellSession` is the VM Shell Session discriminant (issue 06):
          // `true` on the VM-shell variant, `never` (undefined) on the
          // agent/shell variants. The type-safe narrow records which surface
          // the Panel should render into the pty:spawn event payload, so a
          // reconnecting Panel can distinguish a VM-shell spawn from an
          // agent/session spawn when replaying the event tail.
          const shellSession = frame.opts.shellSession === true;
          this.recordPtySpawn(ptyId, frame.opts.taskId, shellSession);
          this.send(ws, { type: "spawned", reqId: frame.reqId, ptyId });
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
        if (this.authVerifier && !this.isAuthenticated()) {
          this.send(ws, { type: "error", reqId: frame.reqId, message: "not-authenticated" });
          return;
        }
        this.handleSubscribe(ws, frame);
        return;
      }
      case "auth": {
        this.handleAuth(ws, frame);
        return;
      }
      // ─── Task / project / session / hook ops (issue 02 schema + issue 07
      // wiring). Task + project ops delegate to the CoreQueryPort so the
      // Panel renders live snapshots with no Panel-side persistence. When no
      // queryPort is configured (a PTY-only Core, or tests), both answer
      // with empty results so the Panel can round-trip them without errors.
      case "tasksList": {
        const tasks = this.queryPort ? this.queryPort.listTasks(frame.projectId) : [];
        this.send(ws, { type: "tasksListResult", reqId: frame.reqId, tasks });
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
          const previousStatus = this.priorTaskStatus(frame.mutation);
          const task = this.mutationPort.mutateTask(frame.mutation);
          if (task) this.recordTaskMutation(frame.mutation, task, previousStatus);
          this.send(ws, { type: "tasksMutateResult", reqId: frame.reqId, task });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.send(ws, { type: "error", reqId: frame.reqId, message });
        }
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
   * Handle a `subscribe` frame: stream the event_log tail past the Panel's
   * `lastEventId` as `event` frames, then send `eventsReplayed` with the new
   * cursor. The per-connection poll loop takes over live push from here.
   * When no event log is configured, reply with an empty tail + the same
   * cursor so the Panel's state machine stays consistent.
   */
  private handleSubscribe(
    ws: WebSocketLike,
    frame: { type: "subscribe"; reqId: string; lastEventId: number },
  ): void {
    const conn = this.connection ?? (this.connection = new ActiveConnection());
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
    ws: WebSocketLike,
    frame: { type: "auth"; reqId: string; bearer: string },
  ): void {
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
      // clears `connection`; a fresh `auth` lands on a fresh connection.
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      return;
    }
    if (this.connection) this.connection.authenticated = true;
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

  close(): void {
    if (this.connection) {
      this.connection.stopPoll();
      this.connection = null;
    }
    this.core.setEmitTarget(null);
    this.activeWs = null;
    this.server.close();
  }
}

/**
 * Per-connection live-event-push state. Tracks whether the Panel has
 * subscribed and the highest eventId it has been sent, so the poll loop only
 * pushes events the Panel hasn't seen.
 */
class ActiveConnection {
  subscribed = false;
  /** True once an `auth` frame has been verified (issue 04). Always true for
   *  loopback (no `authVerifier` configured). */
  authenticated = false;
  lastSentEventId = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

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
}

/**
 * The status a Session carries once its Harness has exited cleanly. The Panel
 * writes it on PTY exit (`terminalExitTaskStatus`); it is the one status this
 * server reads rather than passes through, because it is what raises a finish
 * notification. Typed against the shared vocabulary — type-only, so the Core
 * bundle gains no runtime dependency — so it cannot drift from the word the
 * Panel writes.
 */
const FINISHED_TASK_STATUS: TaskStatus = "finished";

/**
 * Does this mutation itself set the status to `finished`? The one question
 * both halves of the finish path ask — whether to read the prior status, and
 * whether to append the event — so they cannot drift apart and start emitting
 * on writes that only happen to land on a row that is already finished.
 *
 * A `create` never qualifies: a row born `finished` is imported history, not a
 * Session that just ended in front of the operator.
 */
function patchesFinishedStatus(mutation: CoreLinkTaskMutation): boolean {
  return mutation.op === "update" && mutation.status === FINISHED_TASK_STATUS;
}

/**
 * Detect an update mutation whose only patched column is `icon` (issue 09).
 * Anything else patched alongside icon degrades the frame back to
 * `task:updated`, since the Panel-side icon listener doesn't need to fire for
 * mixed edits — a `task:updated` invalidation already picks up icon changes as
 * a side effect of the full row refetch. The narrowing keeps the dedicated
 * `task:iconChanged` kind meaningful: a Panel that only cares about icon
 * subscribes to that kind and skips the rest.
 */
function isIconOnlyUpdate(mutation: CoreLinkTaskMutation): boolean {
  if (mutation.op !== "update") return false;
  if (mutation.icon === undefined) return false;
  return (
    mutation.status === undefined &&
    mutation.title === undefined &&
    mutation.pinned === undefined &&
    mutation.archived === undefined
  );
}

/**
 * Twin of {@link isIconOnlyUpdate} for the `task:pinnedChanged` kind (issue
 * 10). A patch that touches pinned alongside anything else keeps the
 * `task:updated` kind — mixed edits already invalidate the row via the
 * generic listener; the dedicated kind is only useful when pin is the sole
 * change.
 */
function isPinnedOnlyUpdate(mutation: CoreLinkTaskMutation): boolean {
  if (mutation.op !== "update") return false;
  if (mutation.pinned === undefined) return false;
  return (
    mutation.status === undefined &&
    mutation.title === undefined &&
    mutation.icon === undefined &&
    mutation.archived === undefined
  );
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
