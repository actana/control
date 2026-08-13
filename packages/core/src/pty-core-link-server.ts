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
// own auth state, event cursor, poll loop, heartbeat and PTY subscription set —
// and a new connection never closes an existing one. `PtyCore` state (PTYs,
// tasks, the event log) is untouched by a connection arriving or leaving. When
// the last connection goes, `core.setEmitTarget(null)` stops output delivery —
// the PTY buffer retains everything for replay on reconnect.
//
// PTY output fans out *by subscription* (issue 142, ADR 0024 D2). The Core
// still installs one emit target, but a connection receives a PTY's `data` and
// `exit` only after asking for that `ptyId` — see {@link PtySubscription}.
//
// Every Session has at most one writer (issue 144, ADR 0024 D3–D7, D10). The
// `claim` / `release` / `forceTakeover` frames name a Session by `taskId`, the
// {@link SessionLockTable} records which connection holds it, and the
// mutation frames this server serves — `write`, `kill`, and every `tasksMutate`
// addressed at a Session — are refused when *another* connection holds it. The
// gate is here, on the client-facing frames, and nowhere else: `PtyCore.kill`
// has callers inside the Core (the PTY exit paths, the task writer) that are
// nobody's client, and a gate down there would have the Core refuse itself.
//
// That lock state is **published, not discovered by failing** (issue 145, ADR
// 0024 D8). Every Session snapshot this server sends is stamped with the lock as
// the *receiving* connection must be told it — "can you write to this", never
// "who holds it" — and every change to the table appends a dedicated
// `session:lockChanged` event, which replays by cursor like every other event.
// A refusal cannot do either job: it arrives only after the mutation it refuses,
// so a Reader would render an editable terminal until the operator typed into
// it, and the loser of a force takeover would learn of it on its next keystroke.

import log from "./log";
import type { CoreHttpRoutes } from "./core-files-routes";
import type { WebSocketServer, WebSocket } from "ws";
import {
  CORE_LINK_PROTOCOL_VERSION,
  HARNESS_INSTALL_FAILED_EVENT_KIND,
  SESSION_LOCKED_ERROR_CODE,
  SESSION_LOCK_CHANGED_EVENT_KIND,
  parseCoreLinkRequestFrame,
  serializeCoreLinkFrame,
  type CoreLinkSessionLock,
  type CoreLinkSessionLockChangedPayload,
  type CoreLinkSessionLockTransition,
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
} from "@actana/sdk/core-link-frames";
// Re-export the snapshot types so tests / callers can import them from the
// server module alongside {@link CoreQueryPort} (the per-Core navigation
// query port, issue 07).
export type { CoreLinkProjectSnapshot, CoreLinkTaskSnapshot };
import type { PtyCore, PtyCoreEvent } from "./pty-manager";
import { CoreTaskWriter } from "./core-task-writer";
import { SessionLockTable } from "./session-lock-table";

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
  createServer?: (opts: {
    port: number;
    host: string;
    tls?: TlsOptions;
    /**
     * The Core's HTTP surface on the same server (#165). A factory that builds
     * a real `https.Server` wires this to its `request` and `checkContinue`
     * events; a fake one in a test may ignore it. Absent, the server answers
     * no HTTP at all, which is what it did before this ticket.
     */
    httpRoutes?: CoreHttpRoutes;
  }) => WebSocketServerLike;
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
  /**
   * Announce the `multiConnection` capability on `ready`. Defaults to true —
   * this build serves many connections (ADR 0024 D1), so it says so. Exists
   * only so a test can stand up the capability-less Core a real fleet still
   * has plenty of, the same way {@link protocolVersion} stands up a drifted
   * one; a real old Core is a different build entirely.
   */
  announceMultiConnection?: boolean;
  /**
   * The Core's HTTP surface, mounted on the same server this WebSocket listens
   * on (#165 F2, ADR 0028) — one port, one certificate, one bearer, two
   * protocols. **No file byte crosses this WebSocket**, which is the whole
   * reason the routes are over there.
   *
   * Handed in already built rather than constructed from a port here, and
   * deliberately: this class's job is to mount whatever HTTP surface it is
   * given, not to know what that surface is *about*. `core-entry.ts` wires the
   * file routes, next to the query store they read Project roots from — so this
   * module imports only the type, the tar codec never enters its import graph,
   * and a Core with no file surface never loads a line of it.
   */
  httpRoutes?: CoreHttpRoutes;
  /**
   * Announce the `files` capability on `ready` (#165 F9).
   *
   * Defaults to "yes if an HTTP surface is mounted", because today that surface
   * is the file routes and nothing else. **Pass it explicitly** rather than
   * relying on the default if this ever mounts routes that are not the file
   * ones — announcing a capability whose routes are not answering is worse than
   * announcing nothing, since a client that reads the field stops
   * feature-detecting and starts calling. An explicit `false` stands up the
   * capability-less Core a real fleet is still full of, the way
   * {@link announceMultiConnection} does.
   */
  announceFiles?: boolean;
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
 * How much of a PTY's live output one `catchUp` subscription may hold while it
 * waits for its `replay` to be served.
 *
 * Overflow drops the OLDEST held chunks, which is the safe direction and not an
 * arbitrary one: the replay that releases the hold is read from the PTY ring
 * *after* the drop, so anything dropped here is still inside that window (the
 * ring is `RING_LIMIT_BYTES`, an order of magnitude larger). The drain then
 * filters by `nextSeq`, so a dropped chunk is delivered exactly once, by the
 * replay, and never twice. If even the ring has rolled, `replayResult.from`
 * already tells the client its tail has a hole in front of it.
 */
const PTY_HOLD_LIMIT_BYTES = 100_000;

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
  private readonly announceMultiConnection: boolean;
  private readonly announceFiles: boolean;
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
   * Which connection may mutate which Session (issue 144, ADR 0024 D3–D7).
   *
   * One table for the whole Core, not one per connection: the question it
   * answers is "who holds this Session", and every connection has to be able to
   * ask it. Scoped to a Session and never Core-wide (D4) — different Sessions
   * on one Core may be held by different clients at the same time, which is the
   * ordinary case this effort exists to enable, not the contended one.
   *
   * In memory, dying with the Core (D12). There is nothing to persist: the PTYs
   * these locks guard do not survive the daemon either.
   */
  private readonly sessionLocks = new SessionLockTable();
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
    // The routes go to the server factory, because the factory is what mounts
    // them: one https.Server answering a WebSocket upgrade and the `/v1/…`
    // routes, never two listeners (#165 F2, ADR 0028).
    this.announceFiles = opts.announceFiles ?? Boolean(opts.httpRoutes);
    this.server = create({ port: opts.port, host, tls: opts.tls, httpRoutes: opts.httpRoutes });
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
    this.announceMultiConnection = opts.announceMultiConnection ?? true;
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

    // Send the ready frame immediately. It announces `multiConnection`
    // because the registration above is exactly what the capability claims
    // (ADR 0024 D11): this server keeps every connection it accepts. The
    // protocol version does not move for it — a Core that omits the field is
    // the single-connection build, which is a Core like any other.
    this.send(ws, {
      type: "ready",
      version: this.protocolVersion,
      ...(this.announceMultiConnection ? { multiConnection: { version: 1 as const } } : {}),
      // And `files`, on the same terms and for the same reason (#165 F9): this
      // Core answers the `/v1/…` routes on the HTTPS origin this socket is
      // mounted on, so it says so, and the protocol version does not move for
      // it either. A Core that omits the field has no file surface — not a
      // stale one, and not one to mark needs-update.
      ...(this.announceFiles ? { files: { version: 1 as const } } : {}),
    });

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
   * Retire one connection: its poll timer, its heartbeat, and the registry
   * entry that holds its PTY subscriptions — and nothing else. Every other
   * connection keeps its own; the defect this replaces cancelled a shared poll,
   * so one client closing stopped live event push for whoever else was here.
   *
   * Subscriptions need no sweep of their own. They live on the
   * {@link ActiveConnection}, so dropping it drops them, and a client that
   * vanishes without unsubscribing leaves nothing behind (issue 142). The emit
   * target is released only when the last connection goes, which is what makes
   * a Core with no clients quiet again.
   *
   * **Session locks do need a sweep, and it has to be all of them** (issue 144,
   * ADR 0024 D7). They live in a Core-wide table rather than on the connection,
   * precisely so every connection can ask who holds what — which means dropping
   * the connection does not drop them, and a connection may be holding several
   * Sessions at once. A drop is one of the three ways a lock ends, and the other
   * two are gestures a vanished client is in no position to make: a lock missed
   * here is a Session no one can write and no one can release, until a human
   * reaches for a force takeover or the Core restarts. ADR 0024 already accepts
   * a stale connection holding its locks for as long as the heartbeat takes to
   * reap it (45s); leaving one behind here would turn that bound into forever.
   */
  private dropConnection(ws: WebSocketLike, conn: ActiveConnection): void {
    conn.stopHeartbeat();
    conn.stopPoll();
    // Unconditional, and before the identity guard below: this connection is
    // over regardless of whether it is still the one in the registry, and a
    // lock it holds has to go with it either way.
    const released = this.sessionLocks.releaseAll(conn);
    if (released.length > 0) {
      log.info("core-link.session-lock.released-on-drop", { taskIds: released });
    }
    // A drop is one of the three ways a lock ends (D7), so it publishes like
    // the other two (D8): one `session:lockChanged` per Session, after the
    // sweep, so the log says `locked: false` because the table does. A client
    // waiting for a Session a vanished holder was sitting on has no other way to
    // learn it is claimable — nobody sent a frame for it to be answered by.
    for (const taskId of released) this.recordSessionLockChange(taskId, "released");
    // Guard on identity, not presence: a socket that was already replaced in
    // the map must not evict its successor.
    if (this.connections.get(ws) === conn) this.connections.delete(ws);
    if (this.connections.size === 0) this.releaseEmitTarget();
  }

  /**
   * Record this connection's client id and replace whatever connection last
   * presented it: close the predecessor, and move its Session locks here
   * (issue 146, ADR 0024 D9).
   *
   * **This is reaping, not authority, and not identity.** The id is a string a
   * client made up. Nothing signs it, nothing verifies it, and this method is
   * the only thing in the Core that reads it. What it can move is a Session
   * lock — which is authority any authenticated connection can already take
   * unconditionally with `forceTakeover` (D7), so a connection presenting
   * somebody else's id gains nothing it could not have had by asking outright.
   * That is the answer to "how do we stop a client claiming another's id", and
   * it is D10's answer: the client on the other end of this socket holds the
   * bearer, and a bearer holder can open a VM Shell Session and kill the
   * process. A signature here would defend nothing and would quietly build the
   * per-client credential D3 and D10 rejected.
   *
   * Nor does presenting an id authenticate anybody. `reclaim` is not `auth`, so
   * the gate in {@link onMessage} refuses it — and drops the connection — from
   * a client that has not presented its bearer first, exactly like every other
   * frame. The id never substitutes for the bearer and never shortens the path
   * to one.
   *
   * **The transfer is one step, and the order of these three lines is the whole
   * ticket.** {@link SessionLockTable.transferAll} rewrites the holder in place
   * — there is no instant at which those Sessions read as unlocked, so a third
   * connection racing a `claim` (or an outright write against an unlocked
   * Session, which D5/D11 allow) cannot land inside the handover. Only then is
   * the predecessor closed. The reverse order is the bug this ticket exists to
   * prevent: a drop runs `releaseAll`, which would unlock every one of those
   * Sessions on the way out and leave them free for anybody for as long as the
   * successor takes to notice. Run in this order, that same `releaseAll` finds
   * nothing — the entries already name this connection.
   *
   * The predecessor is `terminate`d where the transport offers it, for the
   * reason the heartbeat does: this socket is presumed already dead, and a
   * half-open connection never completes a close handshake, so waiting on one
   * would leave the ghost in the registry it was just evicted from.
   *
   * Every match is handled, not the first. One is all this can produce — a
   * connection presenting an id is the only thing that records one — but a
   * partial sweep here would leave a ghost holding a Session with nothing left
   * to reap it but the heartbeat, which is the outcome the frame exists to
   * avoid.
   */
  private reclaimFor(
    conn: ActiveConnection,
    clientId: string,
  ): { replaced: boolean; taskIds: string[] } {
    conn.clientId = clientId;
    const predecessors: ActiveConnection[] = [];
    for (const other of this.connections.values()) {
      if (other !== conn && other.clientId === clientId) predecessors.push(other);
    }
    // Locks first, in one rewrite each — see above.
    const taskIds: string[] = [];
    for (const predecessor of predecessors) {
      taskIds.push(...this.sessionLocks.transferAll(predecessor, conn));
    }
    // Then the socket. `dropConnection` is called rather than left to the close
    // handler so the registry is correct the moment this frame is answered: a
    // real `close()` is asynchronous, and a client that reconnects twice in
    // quick succession would otherwise find its own ghost still listed. It is
    // idempotent — the locks are already gone from `releaseAll`'s point of view.
    for (const predecessor of predecessors) {
      try {
        predecessor.ws.terminate ? predecessor.ws.terminate() : predecessor.ws.close();
      } catch {
        /* already gone — the drop below is what actually retires it */
      }
      this.dropConnection(predecessor.ws, predecessor);
    }
    if (predecessors.length > 0) {
      log.info("core-link.client-id.reclaimed", {
        replaced: predecessors.length,
        taskIds,
      });
    }
    return { replaced: predecessors.length > 0, taskIds };
  }

  /**
   * Install this server's single PTY-event sink on the Core, once.
   *
   * One callback for the whole server, not one per connection: the target is a
   * single global sink on `PtyCore`, so a per-connection one would have the
   * newest connection silently steal every PTY's output from the rest. Who
   * actually receives a given PTY's bytes is decided downstream of it, in
   * {@link fanOutPtyEvent}, from each connection's subscription set (issue 142,
   * ADR 0024 D2).
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
   * Deliver one PTY event to every *authenticated subscriber* of that PTY, and
   * record an exit exactly once.
   *
   * Subscription is the whole point of D2 (issue 142): a connection that has
   * not asked for this `ptyId` is skipped, so a CLI attached to one Session no
   * longer receives every other Session's output on the machine. A connection
   * mid-catch-up holds the event instead of receiving it — see
   * {@link PtySubscription}.
   *
   * The event log is a fact about the machine, not about who was watching:
   * appending per connection would write two `pty:exit` rows for one dead
   * process and replay the exit twice to every reconnecting client — so the
   * append stays outside the loop, fires once, and a connection being skipped
   * (or there being no subscribers at all) never costs the log a row.
   *
   * The auth skip mirrors `pushLiveEvents`: with an `authVerifier` configured,
   * a connection that has not proved identity gets nothing pushed at it. PTY
   * output is strictly more sensitive than the event timeline, and a socket
   * that presents no bearer and sends no frame never trips the message gate —
   * answering pings keeps `lastInboundAt` fresh, so the heartbeat never reaps
   * it either. Loopback Cores configure no verifier, where `authenticated` is
   * irrelevant and every subscriber is served.
   */
  private fanOutPtyEvent(event: PtyCoreEvent): void {
    const frame: CoreLinkServerFrame =
      event.type === "data"
        ? { type: "data", ptyId: event.ptyId, data: event.data, seq: event.seq }
        : { type: "exit", ptyId: event.ptyId, exitCode: event.exitCode, signal: event.signal };
    for (const conn of this.connections.values()) {
      if (this.authVerifier && !conn.authenticated) continue;
      const sub = conn.ptySubscriptions.get(event.ptyId);
      if (!sub) continue;
      if (sub.holding) {
        sub.hold(event);
        continue;
      }
      this.send(conn.ws, frame);
      // The PTY is gone; so is any reason to keep tracking it on a connection
      // that is not still owed a catch-up. Left in place, one entry per exited
      // PTY per connection would accumulate for the life of a long-lived link.
      if (event.type === "exit") conn.ptySubscriptions.delete(event.ptyId);
    }
    if (event.type === "exit") {
      this.recordPtyExit(event);
    }
  }

  /**
   * Release a `catchUp` hold now that this connection's `replay` has been
   * served, and put the connection's stream live.
   *
   * `nextSeq` is where the window ended — the seq the *next* chunk will get, so
   * it is exclusive. A held chunk below it is already painted and is dropped
   * rather than sent twice; `nextSeq` itself and everything past it is output
   * that arrived *during* the gap this hold exists to close, and goes out in
   * order behind the window.
   *
   * A held `exit` goes last and always goes: a PTY that died between the
   * subscribe and the replay has no second exit to emit, and a subscriber that
   * never learns about it waits forever on a dead process.
   */
  private drainPtyHold(conn: ActiveConnection, ptyId: string, nextSeq: number): void {
    const sub = conn.ptySubscriptions.get(ptyId);
    if (!sub || !sub.holding) return;
    const { data, exit } = sub.release();
    for (const chunk of data) {
      if (chunk.seq < nextSeq) continue;
      this.send(conn.ws, { type: "data", ptyId, data: chunk.data, seq: chunk.seq });
    }
    if (exit) {
      this.send(conn.ws, {
        type: "exit",
        ptyId,
        exitCode: exit.exitCode,
        signal: exit.signal,
      });
      // Same reason as the live path in `fanOutPtyEvent`: the PTY is gone, and
      // an entry for it would sit on this connection until the socket closed.
      conn.ptySubscriptions.delete(ptyId);
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

  /**
   * Refuse a mutation aimed at a Session another connection holds, and say so
   * (issue 144, ADR 0024 D4/D6). Returns true when the frame was refused and
   * the caller must stop.
   *
   * The refusal is an `error` carrying {@link SESSION_LOCKED_ERROR_CODE},
   * because the client has to tell it apart from the other way a mutation fails
   * to land — "that Session is gone" — and those two arrive on different frames:
   * a Session this Core no longer has answers with the ordinary
   * `writeResult { ok: false }` / `killResult { ok: false }` /
   * `tasksMutateResult { task: null }` it always did. One of them is worth
   * retrying after a claim; the other never is.
   *
   * An **unlocked** Session is not refused. That is D11's compatibility promise
   * doing its work: a client that never claims — every client that predates this
   * — meets an unlocked Session and is served exactly as it is today. D6's "a
   * mutation without the lock is an error" governs *acquisition*: a mutation
   * never becomes a claim. It does not make an unclaimed Session unwritable.
   */
  private refuseLockedSession(
    conn: ActiveConnection,
    reqId: string,
    taskId: string | null | undefined,
  ): boolean {
    if (this.sessionLocks.mayMutate(taskId, conn)) return false;
    this.send(conn.ws, {
      type: "error",
      reqId,
      code: SESSION_LOCKED_ERROR_CODE,
      message: "Another Core client holds this Session's lock",
    });
    return true;
  }

  /**
   * The same refusal for a frame that names a `ptyId` rather than a Session —
   * `write` and `kill`.
   *
   * The `ptyId` is resolved to the Task it was spawned for, because that is what
   * a lock is keyed by: a Session is its Task, and keying on the process would
   * give one Session as many locks as it has had PTYs. A `ptyId` this Core has
   * no PTY for resolves to null and is **not** refused — there is no Session
   * there to be holding, and the call below is about to answer `ok: false`,
   * which is precisely the "that Session is gone" answer the caller needs.
   */
  private refuseLockedPty(conn: ActiveConnection, reqId: string, ptyId: string): boolean {
    return this.refuseLockedSession(conn, reqId, this.core.taskIdForPty(ptyId));
  }

  /**
   * Stamp every Session snapshot on its way out with the lock as **this**
   * connection must be told it (issue 145, ADR 0024 D8).
   *
   * Here rather than in a query port, for two reasons that are really one. The
   * lock table is in memory and dies with the Core (D12), so no store has the
   * fact to read; and the answer is different for every recipient — the same
   * Session is `held-by-you` to its holder and `held-by-another` to everyone
   * else — so there is no single value a shared read path could have returned.
   * A snapshot is addressed at a connection, which is exactly where this belongs.
   *
   * The rows are copied rather than patched. They come from a query port whose
   * real implementation reads SQLite fresh each call, but writing a
   * per-connection field into an object a port might cache or hand to a second
   * connection is the one way this could leak a holder to a watcher, and a spread
   * costs nothing on a list a human is going to look at.
   *
   * A Core that does not announce `multiConnection` stamps nothing. It has told
   * the client it has no lock table (D11), and publishing state for a table it
   * says it does not have would be the same Core answering two ways.
   */
  private withPublishedLock<T extends { taskId: string; lock?: CoreLinkSessionLock }>(
    conn: ActiveConnection,
    rows: T[],
  ): T[] {
    if (!this.announceMultiConnection) return rows;
    return rows.map((row) => ({ ...row, lock: this.sessionLocks.stateFor(row.taskId, conn) }));
  }

  /**
   * Record a Session-lock change in the event log, so every other connection
   * learns of it without asking (issue 145, ADR 0024 D8).
   *
   * A **dedicated kind**, on the precedent ADR 0022 set for
   * `project:appearanceChanged`: widening `task:updated` to carry lock state
   * would stop that frame documenting what changed, and a reconnecting client
   * replaying a tail could not tell a takeover it must react to from a title
   * edit it can ignore — which is the generic-field-patch failure ADR 0017 and
   * ADR 0022 both rejected.
   *
   * The payload names no client (D3, D10). One row is read by every connection,
   * so anything identifying in it would be broadcast to every watcher of this
   * Core; "can I write to it now" is the snapshot's question, asked per
   * connection, and this event is what tells a client the answer has moved.
   *
   * `locked` is read back off the table rather than inferred from the
   * transition, so the log cannot drift from the state it describes.
   */
  private recordSessionLockChange(
    taskId: string,
    transition: CoreLinkSessionLockTransition,
  ): void {
    if (!this.announceMultiConnection || !this.eventLog) return;
    const payload: CoreLinkSessionLockChangedPayload = {
      taskId,
      transition,
      locked: this.sessionLocks.holderOf(taskId) !== null,
    };
    this.eventLog.appendEvent(SESSION_LOCK_CHANGED_EVENT_KIND, JSON.stringify(payload), {
      taskId,
      ptyId: null,
    });
  }

  private async dispatch(conn: ActiveConnection, frame: CoreLinkRequestFrame): Promise<void> {
    const ws = conn.ws;
    switch (frame.type) {
      case "spawn": {
        // Gated on the `taskId` the spawn names, which D4 does not enumerate —
        // it lists `write`, `kill` and every task mutation. Gated anyway,
        // because a `spawn` naming a Session another connection holds starts a
        // *second* process on the Session that connection is driving, which is
        // the interference D4 exists to prevent rather than a new one: two
        // harnesses in one worktree is a worse outcome than the stray keystroke
        // the lock was written for.
        //
        // The reading `resize` got does not transfer. A Reader has a real use
        // for a resize — it is painting the scrollback into a viewport of its
        // own — and no use at all for a spawn it may not then type into: the
        // lock is keyed by `taskId` for every PTY kind, so the very next `write`
        // to the PTY this frame would create comes back `session-locked`. A
        // refusal here is the same answer, one round trip earlier and legible.
        //
        // A Session nobody holds is still spawned for anybody, so D5's window
        // is untouched: a creator spawns without claiming exactly as before, and
        // `tasksMutate`'s `create` — which names no existing Session — keeps its
        // own carve-out. Only a `taskId` **another** connection holds is
        // refused.
        if (this.refuseLockedSession(conn, frame.reqId, frame.opts.taskId)) return;
        try {
          const { ptyId, hooksReportTurnStart } = await this.core.spawn(frame.opts);
          // `shellSession` is the VM Shell Session discriminant (issue 06):
          // `true` on the VM-shell variant, `never` (undefined) on the
          // agent/shell variants. The type-safe narrow records which surface
          // the Panel should render into the pty:spawn event payload, so a
          // reconnecting Panel can distinguish a VM-shell spawn from an
          // agent/session spawn when replaying the event tail.
          const shellSession = frame.opts.shellSession === true;
          // The connection that spawned a PTY is subscribed to it, here, before
          // its `spawned` answer goes out (issue 142). It could not have asked
          // earlier — the id did not exist — and the harness starts printing
          // immediately, so anything else loses the banner in the round trip
          // between this answer and a `ptySubscribe` coming back. Live rather
          // than holding: nothing precedes these bytes, so there is no
          // scrollback to reconcile them against. Any other connection that
          // wants this PTY still has to ask.
          conn.subscribePty(ptyId, false);
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
        if (this.refuseLockedPty(conn, frame.reqId, frame.ptyId)) return;
        const ok = this.core.write(frame.ptyId, frame.data);
        this.send(ws, { type: "writeResult", reqId: frame.reqId, ok });
        return;
      }
      case "resize": {
        // Deliberately not gated. D4 names the mutations the lock covers —
        // `write`, `kill`, and every task mutation addressed at the Session —
        // and a resize is none of them: it is how a client tells the PTY the
        // size of the viewport it is painting into, and every Reader has one.
        // A Reader whose resize were refused would render the Session's
        // scrollback reflowed to somebody else's terminal, which is a worse
        // answer than the interference gating it would prevent. Widening D4 to
        // cover it is an amendment to #140, not a call for this ticket.
        const ok = this.core.resize(frame.ptyId, frame.cols, frame.rows);
        this.send(ws, { type: "resizeResult", reqId: frame.reqId, ok });
        return;
      }
      case "kill": {
        // The client-facing kill, and the only one that is gated. `PtyCore.kill`
        // keeps answering its callers inside the Core — the PTY exit paths, the
        // task writer — which hold no lock and are nobody's client.
        if (this.refuseLockedPty(conn, frame.reqId, frame.ptyId)) return;
        const ok = this.core.kill(frame.ptyId);
        this.send(ws, { type: "killResult", reqId: frame.reqId, ok });
        return;
      }
      // ─── Session lock (issue 144, ADR 0024 D3–D7, D10) ───
      case "claim": {
        // Read the prior state before taking it: a re-claim by the connection
        // that already holds the Session is idempotent and changes nothing, and
        // an event for it would be a lock change nobody made — the same reason
        // `recordProjectMutation` appends only for a mutation that landed.
        const alreadyHeld = this.sessionLocks.isHeldBy(frame.taskId, conn);
        const { granted } = this.sessionLocks.claim(frame.taskId, conn);
        // A denied claim leaves the holder untouched, so there is nothing to
        // publish; the caller reads `granted: false` and the watchers were never
        // wrong about anything.
        if (granted && !alreadyHeld) this.recordSessionLockChange(frame.taskId, "claimed");
        this.send(ws, {
          type: "claimResult",
          reqId: frame.reqId,
          taskId: frame.taskId,
          granted,
        });
        return;
      }
      case "release": {
        const released = this.sessionLocks.release(frame.taskId, conn);
        // Only a release that actually released something. A stale client
        // releasing a lock it already lost is talking about the past, and
        // publishing it would announce a transition that did not happen — to
        // watchers, indistinguishable from the holder having just let go.
        if (released) this.recordSessionLockChange(frame.taskId, "released");
        this.send(ws, {
          type: "releaseResult",
          reqId: frame.reqId,
          taskId: frame.taskId,
          released,
        });
        return;
      }
      case "forceTakeover": {
        const { takenFrom } = this.sessionLocks.forceTakeover(frame.taskId, conn);
        if (takenFrom === "another-connection") {
          // Worth a line in the Core's log even though nothing failed: this is
          // the one lock transition an operator did not agree to, and the
          // loser's in-flight keystrokes are gone (ADR 0024, known risks).
          log.info("core-link.session-lock.force-takeover", { taskId: frame.taskId });
        }
        // Published in the vocabulary of the lock, not of the frame: a takeover
        // of a Session nobody held is a `claimed`, because nobody was evicted
        // and no watcher should be told otherwise. Taking a Session this
        // connection already holds changes nothing and publishes nothing.
        //
        // This is the transition D8 exists for. The loser is not answered — it
        // sent no frame — so without this event it would keep painting an
        // editable terminal until its next keystroke came back `session-locked`.
        // It learns here instead, on the ordinary event stream, having polled
        // nothing.
        if (takenFrom !== "this-connection") {
          this.recordSessionLockChange(
            frame.taskId,
            takenFrom === "nobody" ? "claimed" : "taken-over",
          );
        }
        this.send(ws, {
          type: "forceTakeoverResult",
          reqId: frame.reqId,
          taskId: frame.taskId,
          takenFrom,
        });
        return;
      }
      case "reclaim": {
        // A `clientId` that is not a non-empty string is no id at all, not a
        // shared one. Left ungated, two connections that both sent the field
        // as `undefined` would match each other and reap in turn — which is
        // the one way a frame this permissive can misfire.
        const clientId = typeof frame.clientId === "string" ? frame.clientId : "";
        const { replaced, taskIds } = clientId
          ? this.reclaimFor(conn, clientId)
          : { replaced: false, taskIds: [] as string[] };
        this.send(ws, {
          type: "reclaimResult",
          reqId: frame.reqId,
          clientId,
          replaced,
          taskIds,
        });
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
        // This is the frame that releases a `catchUp` hold, and it releases it
        // only after the window above has gone out. That ordering is the whole
        // contract (issue 142): subscribe, hold, replay from the client's own
        // `sinceSeq`, then drain — never the reverse, which would paint live
        // bytes in front of the scrollback they belong after.
        this.drainPtyHold(conn, frame.ptyId, result.nextSeq);
        return;
      }
      case "ptySubscribe": {
        const sub = conn.subscribePty(frame.ptyId, frame.catchUp === true);
        this.send(ws, {
          type: "ptySubscribeAck",
          reqId: frame.reqId,
          ptyId: frame.ptyId,
          subscribed: true,
          holding: sub.holding,
        });
        return;
      }
      case "ptyUnsubscribe": {
        conn.unsubscribePty(frame.ptyId);
        this.send(ws, {
          type: "ptyUnsubscribeAck",
          reqId: frame.reqId,
          ptyId: frame.ptyId,
          subscribed: false,
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
        // Stamped with this connection's own lock state (issue 145, D8). This
        // is the frame a Panel hydrates its Fleet view from, so it is where a
        // Reader's terminal is decided to be read-only — before a keystroke,
        // which is the whole of what "published, not discovered by failing"
        // buys over the refusal that would otherwise be the first news of it.
        const tasks = this.withPublishedLock(
          conn,
          this.queryPort ? this.queryPort.listTasks(frame.projectId) : [],
        );
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
        // Archived rows carry it too. A Session is claimable whatever its
        // archived flag says — the lock is keyed by `taskId` and knows nothing
        // about the column — so a snapshot that omitted it here would be the one
        // list where "can I write to this" went unanswered.
        const tasks = this.withPublishedLock(
          conn,
          this.queryPort ? this.queryPort.listArchivedTasks(frame.projectId) : [],
        );
        this.send(ws, { type: "archivedTasksListResult", reqId: frame.reqId, tasks });
        return;
      }
      case "projectsList": {
        const projects = this.queryPort ? this.queryPort.listProjects() : [];
        this.send(ws, { type: "projectsListResult", reqId: frame.reqId, projects });
        return;
      }
      case "tasksMutate": {
        // "Every task mutation addressed at that Session" (D4). An `update` or
        // a `delete` names a taskId and is therefore addressed at one; a
        // `create` names no existing Session and so has none to be refused by —
        // an automation holding one Session must still be able to start another.
        if (
          frame.mutation.op !== "create" &&
          this.refuseLockedSession(conn, frame.reqId, frame.mutation.taskId)
        ) {
          return;
        }
        if (!this.mutationPort) {
          this.send(ws, { type: "tasksMutateResult", reqId: frame.reqId, task: null });
          return;
        }
        try {
          // The Panel's write and the Core's own writes (hooks, PTY exit, the
          // title generator) share one seam, so the row and the events that
          // describe it never come apart (issue 84).
          const task = this.taskWriter.mutate(frame.mutation);
          // The answer to a mutation is a Session snapshot like any other, so
          // it carries the lock like any other — including the `create` that
          // just made this Session, which comes back `unlocked` and says so.
          // That is D5 on the wire: the creator got no privilege, and the client
          // reads that rather than assuming either way.
          const [stamped] = task ? this.withPublishedLock(conn, [task]) : [null];
          this.send(ws, { type: "tasksMutateResult", reqId: frame.reqId, task: stamped });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.send(ws, { type: "error", reqId: frame.reqId, message });
        }
        return;
      }
      case "harnessPrompt": {
        // A task mutation addressed at a Session, so D4 covers it: the prompt
        // reaches the title generator, which writes the task row's title
        // through the same `taskWriter` a gated `tasksMutate` uses. The frame
        // reads like telemetry and lands as a write, and "every task mutation
        // addressed at that Session" is decided by where it lands. Small in
        // consequence — the generator leaves a real or operator-set title alone
        // — but a connection holding nothing must not rename a Session another
        // connection is driving.
        if (this.refuseLockedSession(conn, frame.reqId, frame.taskId)) return;
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
        // The frame `actana session ls` reads (D8): a list of Sessions, each
        // saying whether this client may write to it. Same stamp, same rule as
        // `tasksList` — a CLI and a Panel asking about one Session are asking
        // the same question and must not get different vocabularies for it.
        const sessions = this.withPublishedLock(
          conn,
          this.mutationPort ? this.mutationPort.listSessions(frame.projectId) : [],
        );
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

  /**
   * @internal How many PTY subscriptions this Core is holding, across every
   * connection. Exists so a test can assert the leak the registry is supposed
   * to make impossible: a client that disappears without unsubscribing leaves
   * this at zero, and so does a PTY that exits.
   */
  ptySubscriptionCount(): number {
    let total = 0;
    for (const conn of this.connections.values()) total += conn.ptySubscriptions.size;
    return total;
  }

  /**
   * @internal How many Sessions are locked right now, across every connection.
   * Exists so a test can assert the sweep D7 requires: a client that disappears
   * holding several Sessions leaves this at zero.
   */
  sessionLockCount(): number {
    return this.sessionLocks.heldCount();
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
    // Locks die with the Core (D12). Nothing here is handed on to a next
    // process, and a Core that comes back returns every Session to unlocked —
    // the correct state for a Session with no running process behind it.
    this.sessionLocks.clear();
    this.releaseEmitTarget();
    this.server.close();
  }
}

/**
 * One PTY this connection has asked for, and — while it is catching up — the
 * output it is owed but must not receive yet (issue 142, ADR 0024 D2).
 *
 * A `catchUp` subscription starts `holding`. Live `data`/`exit` for the PTY
 * accumulate here instead of going out, until the connection's `replay` for
 * that PTY is served; `release()` hands them over and puts the stream live for
 * good. Without the hold, the bytes emitted between the subscription taking
 * effect and the replay being served would arrive *before* the scrollback they
 * come after, and the client would paint them in the wrong order.
 *
 * Holding is bounded by {@link PTY_HOLD_LIMIT_BYTES}; see that constant for why
 * dropping the oldest is lossless here.
 */
class PtySubscription {
  private data: Array<{ data: string; seq: number }> = [];
  private bytes = 0;
  private exit: { exitCode: number; signal?: number } | null = null;

  constructor(public holding: boolean) {}

  /** Take one event out of the live stream and keep it for the drain. */
  hold(event: PtyCoreEvent): void {
    if (event.type === "exit") {
      this.exit = { exitCode: event.exitCode, signal: event.signal };
      return;
    }
    this.data.push({ data: event.data, seq: event.seq });
    this.bytes += event.data.length;
    while (this.bytes > PTY_HOLD_LIMIT_BYTES && this.data.length > 0) {
      this.bytes -= this.data.shift()!.data.length;
    }
  }

  /** Everything held, in arrival order; the subscription goes live. */
  release(): { data: Array<{ data: string; seq: number }>; exit: { exitCode: number; signal?: number } | null } {
    const held = { data: this.data, exit: this.exit };
    this.holding = false;
    this.data = [];
    this.bytes = 0;
    this.exit = null;
    return held;
  }
}

/**
 * One core-link connection's own state: whether it has authenticated, whether
 * it has subscribed to the event log, the highest eventId it has been sent,
 * which PTYs it wants the byte stream of, its live-event poll and its
 * heartbeat. Every field here is private to one client — this shape always was
 * per-connection; before issue 141 it was simply only ever instantiated once,
 * and the server held the socket beside it.
 *
 * Nothing about a Session, a PTY or the event log lives here. Those are Core
 * facts, shared by construction, and a connection arriving or leaving must not
 * move any of them. That is also what makes subscriptions leak-proof: they are
 * fields on this object, so a client that disappears without unsubscribing
 * takes its whole subscription set with it when the connection is dropped —
 * there is no server-level registry keyed by `ptyId` to go stale.
 */
class ActiveConnection {
  subscribed = false;
  /** PTYs this connection receives `data`/`exit` for, keyed by `ptyId`. */
  readonly ptySubscriptions = new Map<string, PtySubscription>();
  /** True once an `auth` frame has been verified (issue 04). Always true for
   *  loopback (no `authVerifier` configured). */
  authenticated = false;
  /**
   * The client id this connection presented on its `reclaim` frame, or null
   * from one that never presented one (issue 146, ADR 0024 D9).
   *
   * Reaping is the only thing it is read for: a later connection presenting the
   * same string is treated as the same Core client reconnecting, so this one is
   * closed and its Session locks move across. It is never checked against
   * anything, never compared with the bearer, and grants nothing — see the
   * commentary on {@link PtyCoreLinkServer.reclaimFor}.
   */
  clientId: string | null = null;
  lastSentEventId = 0;
  /** Last time anything arrived from this client — a frame, or a pong. */
  lastInboundAt = Date.now();
  /** This connection's ping timer; only it may reap this connection. */
  heartbeat: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly ws: WebSocketLike) {}

  /**
   * Ask for a PTY's stream. Idempotent: an existing subscription is returned
   * untouched, so a second `ptySubscribe` neither doubles delivery nor — more
   * dangerously — re-arms a hold on a stream that is already live and would
   * then never be released (nothing more is coming to release it).
   */
  subscribePty(ptyId: string, catchUp: boolean): PtySubscription {
    const existing = this.ptySubscriptions.get(ptyId);
    if (existing) return existing;
    const sub = new PtySubscription(catchUp);
    this.ptySubscriptions.set(ptyId, sub);
    return sub;
  }

  /** Stop receiving a PTY's stream. Idempotent — unsubscribing twice is fine. */
  unsubscribePty(ptyId: string): void {
    this.ptySubscriptions.delete(ptyId);
  }

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
  httpRoutes?: CoreHttpRoutes;
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
    mountHttpRoutes(tlsServer, opts.httpRoutes);
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
  if (opts.httpRoutes) {
    // A loopback Core with a file surface. The explicit `http.Server` exists
    // only on this branch and only when there are routes to mount: the
    // `WebSocketServer({ port })` form below owns its own listener and gives no
    // seam to hang a request handler on, and swapping every loopback Core onto
    // this path to serve routes it does not have would change what a non-upgrade
    // request gets back for no reason this ticket has.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = require("node:http") as typeof import("node:http");
    const plainServer = http.createServer();
    mountHttpRoutes(plainServer, opts.httpRoutes);
    plainServer.listen(opts.port, opts.host);
    const mounted = new WebSocketServer({ server: plainServer });
    return {
      close: (cb) => {
        mounted.close(() => plainServer.close(cb));
      },
      on: (event, cb) => {
        if (event === "connection") {
          mounted.on("connection", (ws: WebSocket) => {
            (cb as (ws: WebSocketLike) => void)(adaptWs(ws));
          });
        } else if (event === "error") {
          mounted.on("error", (err: Error) => (cb as (err: Error) => void)(err));
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

/**
 * Hang the Core's `/v1/…` routes on the server the WebSocket is mounted on
 * (#165 F2, ADR 0028).
 *
 * Everything the routes do not claim gets a 404 from here rather than from
 * them, which is what keeps the Core's HTTP surface a closed list: a path this
 * build does not serve is answered, not left hanging, and adding a route is a
 * change in one file rather than an accident of prefix matching.
 *
 * `checkContinue` is listened for deliberately. Registering a listener is what
 * stops Node auto-answering `Expect: 100-continue` with a `100 Continue`, and
 * that auto-answer is precisely what would make a refused-because-busy upload
 * (F8) send its whole body first.
 */
function mountHttpRoutes(
  server: import("node:http").Server | import("node:https").Server,
  routes: CoreHttpRoutes | undefined,
): void {
  if (!routes) return;
  server.on("request", (req, res) => {
    if (routes.handle(req, res)) return;
    respondNotFound(res);
  });
  server.on("checkContinue", (req, res) => {
    if (routes.handleContinue(req, res)) return;
    respondNotFound(res);
  });
}

function respondNotFound(res: import("node:http").ServerResponse): void {
  const body = JSON.stringify({ code: "not-found", error: "no such route on this Core" });
  res.writeHead(404, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
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
