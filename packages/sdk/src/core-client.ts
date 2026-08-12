// `CoreClient` — the default entry point: connect, authenticate, ask, close.
//
// One socket, one Core, mTLS + bearer from a registration blob (#129 D1, D5).
// **There is no `Fleet` type here and there must not be**: a Core client speaks
// to the machine it dialed, and holding several is the Panel's job, not a shape
// this package grows. That is D5, and the Panel remains the fleet.
//
// This is what the CLI and a script use (#129 D6, "one-shot is the default"):
// connect, ask a question, act on the answer, exit. It does not reconnect, does
// not persist an event cursor, and does not ping — every one of those belongs to
// a program that stays up, and that program is
// {@link DurableCoreClient} in `durable-core-client.ts`, which is this class
// plus a supervisor. Both sit on one {@link CoreLinkTransport}, so the wire is
// written once.
//
// Extracted from the Panel's `PtyCoreLinkClient` (issue 153). The typed method
// set below is deliberately that class's, frame for frame, so the Panel's
// migration (#156) is a swap rather than a rewrite of its call sites; the parts
// that class did *not* have — an explicit `connect()` you can await, a
// connection that does not resurrect itself — are what a one-shot client needs
// and a Panel never asked for.

import {
  coreLinkProtocolCompatible,
  readMultiConnectionCapability,
  type CoreLinkErrorCode,
  type CoreLinkEvent,
  type CoreLinkHarnessAvailabilityMap,
  type CoreLinkLaunchProcessKillResult,
  type CoreLinkMultiConnectionCapability,
  type CoreLinkProjectMutation,
  type CoreLinkProjectSnapshot,
  type CoreLinkPtyReplay,
  type CoreLinkPtySpawnOptions,
  type CoreLinkRequestFrame,
  type CoreLinkResponseFrame,
  type CoreLinkSessionSnapshot,
  type CoreLinkSessionTakenFrom,
  type CoreLinkTaskMutation,
  type CoreLinkTaskSnapshot,
} from "./core-link-frames.ts";
import {
  CoreLinkTransport,
  type CoreLinkAuthErrorReason,
  type CoreLinkAuthOkFrame,
  type CoreLinkDataFrame,
  type CoreLinkExitFrame,
  type CoreLinkHeartbeatOptions,
  type CoreLinkReadyFrame,
} from "./core-link-transport.ts";
import {
  createNodeCoreLinkSocket,
  type CoreLinkSocketFactory,
  type CoreLinkTlsMaterial,
} from "./core-link-socket.ts";
import { coreConnectionFromBlob, type CoreRegistrationBlob } from "./core-registration-blob.ts";

/**
 * Request frames that only mean anything against a Core announcing
 * `multiConnection` on `ready` (ADR 0024 D11) — the one list
 * {@link CoreClient.canSendMultiConnectionFrames} guards.
 *
 * `ptySubscribe` / `ptyUnsubscribe` (ADR 0024 D2) are the first entries: a Core
 * that fans a PTY out per subscription is exactly a multi-connection Core, and
 * one that never announced the capability has no subscription list to put a PTY
 * on. The Session lock's `claim` / `release` / `forceTakeover` (D3–D7) joined
 * them for the same reason in its own key: a single-connection Core has no lock
 * table to address, because it evicts every client but one and therefore has
 * nothing for a lock to arbitrate between. `reclaim` (D9) is the sharpest of the
 * three: a single-connection Core evicts its predecessor on connect *already*,
 * so the frame asks for what that Core has just done, out of a lock table it
 * does not have.
 *
 * Being in this set is not the whole story for a frame whose caller has
 * something better to do than fail. A caller that can degrade consults
 * {@link CoreClient.canSendMultiConnectionFrames} and takes the
 * single-connection route itself — see {@link CoreClient.ptySubscribe} and
 * {@link CoreClient.claim}, which both do exactly that. The rejection in
 * {@link CoreClient.request} is the backstop for callers that ask without
 * checking, not the designed path for the frames listed here.
 */
export const MULTI_CONNECTION_ONLY_FRAME_TYPES: ReadonlySet<CoreLinkRequestFrame["type"]> =
  new Set<CoreLinkRequestFrame["type"]>([
    "ptySubscribe",
    "ptyUnsubscribe",
    "claim",
    "release",
    "forceTakeover",
    "reclaim",
  ]);

/**
 * The rejection a caller gets when the Core answers a request with an `error`
 * frame — carrying that frame's machine-readable {@link CoreLinkErrorCode}
 * alongside its prose (issue 144).
 *
 * `code` exists precisely so a caller does not have to match on `message`, and a
 * client that threw a bare `Error` would put the parsing back that the field was
 * added to remove. It is optional on the wire and optional here: absent on every
 * error that shipped before the field, so a reader takes the code when it is
 * there and falls back to the message when it is not — never the reverse.
 *
 * `session-locked` is its first value and the reason this class exists: a
 * mutation refused because another Core client holds that Session throws,
 * whereas a mutation aimed at a Session this Core no longer has resolves
 * (`ok: false` / `task: null`). One of the two is worth retrying after a claim
 * and the other never is, and telling them apart is the caller's whole job.
 */
export class CoreLinkRequestError extends Error {
  /** The `code` off the `error` frame, when it carried one. */
  readonly code?: CoreLinkErrorCode;

  constructor(message: string, code?: CoreLinkErrorCode) {
    super(message);
    this.name = "CoreLinkRequestError";
    this.code = code;
  }
}

/** Thrown when a bearer is refused: `expired`, `bad-signature`, `malformed`. */
export class CoreLinkAuthError extends Error {
  readonly reason: CoreLinkAuthErrorReason;

  constructor(reason: CoreLinkAuthErrorReason) {
    super(`core-link authentication failed: ${reason}`);
    this.name = "CoreLinkAuthError";
    this.reason = reason;
  }
}

/** What a connected Core told this client about itself, on `ready` and `authOk`. */
export type CoreConnectionInfo = {
  /** The protocol version off `ready`, or null when the frame carried none. */
  protocolVersion: string | null;
  /** Does this build speak that version? See `coreLinkProtocolCompatible`. */
  compatible: boolean;
  /** The `multiConnection` capability, or null on a single-connection Core. */
  multiConnection: CoreLinkMultiConnectionCapability | null;
  /** The `coreId` off `authOk`; null when no bearer was configured. */
  coreId: string | null;
  /** The bearer's expiry off `authOk`; null when no bearer was configured. */
  bearerExpiresAt: number | null;
};

export type CoreClientOptions = {
  /** The core-link URL to dial. Ignored when {@link CoreClientOptions.blob} is set. */
  url?: string;
  /** PEM material for the mTLS handshake (ADR 0002). Ignored when `blob` is set. */
  tls?: CoreLinkTlsMaterial | null;
  /**
   * The signed bearer presented in the `auth` frame (ADR 0002). Required by
   * every real Core; omitted only by a loopback rig or a test.
   */
  bearer?: string | null;
  /**
   * A registration blob — endpoint, PEM material and bearer in one object, which
   * is how a Core client is actually configured (#129 D1/D9). Set this and the
   * three fields above are read off it.
   */
  blob?: CoreRegistrationBlob;
  /**
   * How to open the socket. Defaults to the Node `ws` dial with the `tls`
   * material — the only transport that can present a client certificate.
   * Injectable for tests and for a runtime with its own WebSocket.
   */
  createSocket?: CoreLinkSocketFactory;
  /** Deadline for {@link CoreClient.connect}. Default 30s. */
  connectTimeoutMs?: number;
  /** Default deadline for one request. Default 30s. */
  requestTimeoutMs?: number;
  /**
   * Arm the connection heartbeat. Off by default here and on in
   * {@link DurableCoreClient} — see {@link CoreLinkTransport}.
   */
  heartbeat?: CoreLinkHeartbeatOptions | false;
  /**
   * This client's stable Core client id, presented on every connection so a Core
   * reaps the socket this one replaces (ADR 0024 D9).
   *
   * Default: a fresh id per instance. That is honest rather than a shortcut —
   * the id's job is to span a *reconnect*, and only a client that reconnects has
   * one to span. Pass one explicitly to make it outlive the process, and keep it
   * per Core client: it must never be anything off the registration blob, which
   * is machine-scoped, or the Panel, the CLI and every automation on that
   * machine become one client, each reconnect reaping the others.
   */
  clientId?: string;
  /**
   * Overrides {@link MULTI_CONNECTION_ONLY_FRAME_TYPES}. Exists only so a test
   * can drive the rejection in {@link CoreClient.request} with a stand-in frame
   * type: the real entries all degrade at their call sites rather than reach
   * that backstop. Production never passes it.
   */
  multiConnectionOnlyFrameTypes?: ReadonlySet<string>;
};

/** Default deadline for a dial: `ready` plus, with a bearer, `authOk`. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** Default deadline for one request/response round trip. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type Unsubscribe = () => void;

/** One caller's outstanding request — queued, in flight, or timing out. */
type PendingRequest = {
  frame: CoreLinkRequestFrame;
  resolve: (frame: CoreLinkResponseFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
};

/**
 * Mint this client's Core client id (ADR 0024 D9).
 *
 * Random rather than derived from anything: two clients must not collide, and
 * every input that would make an id stable across processes — the endpoint, the
 * coreId, the bearer — is shared by every client dialing that machine, which is
 * the one shape D9 forbids. Unguessability buys nothing security-wise and is not
 * claimed to; nothing verifies this string, and a Core hands out no more to a
 * client presenting it than to one that asks for a `forceTakeover` outright.
 *
 * The `sdk-` prefix is for the Core's log, where a reclaim line is otherwise an
 * opaque token with no clue which of a machine's clients reconnected.
 */
function mintCoreClientId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `sdk-${random}`;
  // Every runtime this supports has `crypto.randomUUID`. The fallback keeps an
  // id — which only has to differ from its neighbours — from being the thing
  // that throws in an exotic one.
  return `sdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A Core client over one core link.
 *
 * Lifecycle: construct, `await connect()`, ask, `close()`. Construction opens
 * nothing — a client you have not connected has sent no bytes, which is what
 * makes `connect()`'s rejection the one place a dial failure is reported.
 */
export class CoreClient {
  /** The URL this client dials. Public because a log line without it is a riddle. */
  readonly url: string;
  /**
   * This client's Core client id — the same string on every connection it opens,
   * which is the whole of what makes a reconnect reclaimable (ADR 0024 D9).
   *
   * Readonly: an id that moved between connections would reclaim nothing and
   * leave the predecessor holding its Sessions for the full heartbeat timeout,
   * which is the exact failure the frame exists to remove.
   */
  readonly clientId: string;

  protected readonly createSocket: CoreLinkSocketFactory;
  protected readonly bearer: string | null;
  protected readonly heartbeat: CoreLinkHeartbeatOptions | false;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly multiConnectionOnlyFrameTypes: ReadonlySet<string>;

  protected transport: CoreLinkTransport | null = null;
  protected closed = false;
  /**
   * True once a `subscribe` has gone out for this client — see
   * {@link subscribeEvents}. Per client rather than per connection: it records
   * that this client *wants* the event stream, which is what a reconnecting
   * subclass re-asks for, and what stops a second caller asking twice.
   */
  private eventsSubscribed = false;
  /** True once this connection has been established — reset per connection. */
  private established = false;

  /** Requests written to no socket yet. They survive a reconnect; a timeout is what ends them. */
  private readonly queue: PendingRequest[] = [];
  /** Requests on the wire right now, so a dying socket can fail them at once. */
  private readonly inFlight = new Set<PendingRequest>();

  private connectPromise: Promise<CoreConnectionInfo> | null = null;
  private connectSettle: {
    resolve: (info: CoreConnectionInfo) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  /** This connection's `ready` frame; null before it lands and after a drop. */
  private ready: CoreLinkReadyFrame | null = null;
  /**
   * This Core's `multiConnection` capability as announced on the *current*
   * connection; null when absent and before `ready` lands.
   *
   * Re-read on every `ready` rather than remembered across connections: a Core
   * can be downgraded, and a stale `true` here would send frames the Core no
   * longer understands. Null until the frame arrives, so the gate is closed
   * during the window where the answer is genuinely unknown.
   */
  private multiConnection: CoreLinkMultiConnectionCapability | null = null;
  private authOkFrame: CoreLinkAuthOkFrame | null = null;

  private readonly readyListeners = new Set<(info: CoreConnectionInfo) => void>();
  private readonly dataListeners = new Set<(frame: CoreLinkDataFrame) => void>();
  private readonly exitListeners = new Set<(frame: CoreLinkExitFrame) => void>();
  private readonly eventListeners = new Set<(msg: { event: CoreLinkEvent }) => void>();
  private readonly eventsReplayedListeners = new Set<(msg: { lastEventId: number }) => void>();
  private readonly authOkListeners = new Set<(msg: { coreId: string; exp: number }) => void>();
  private readonly authErrorListeners = new Set<
    (msg: { reason: CoreLinkAuthErrorReason }) => void
  >();
  private readonly disconnectedListeners = new Set<(msg: { error?: string }) => void>();
  private readonly reclaimedListeners = new Set<
    (msg: { replaced: boolean; taskIds: string[] }) => void
  >();

  constructor(opts: CoreClientOptions) {
    const connection = opts.blob ? coreConnectionFromBlob(opts.blob) : null;
    const url = connection?.url ?? opts.url;
    if (!url) {
      throw new Error("CoreClient needs a url or a registration blob to dial");
    }
    this.url = url;
    const tls = connection ? connection.tls : (opts.tls ?? null);
    this.bearer = connection ? connection.bearer : (opts.bearer ?? null);
    this.createSocket =
      opts.createSocket ?? ((dialUrl: string) => createNodeCoreLinkSocket(dialUrl, tls ?? undefined));
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.heartbeat = opts.heartbeat ?? false;
    this.clientId = opts.clientId ?? mintCoreClientId();
    this.multiConnectionOnlyFrameTypes =
      opts.multiConnectionOnlyFrameTypes ?? MULTI_CONNECTION_ONLY_FRAME_TYPES;
  }

  /** Build a client straight off a registration blob (#129 D1). */
  static fromRegistrationBlob(
    blob: CoreRegistrationBlob,
    opts: Omit<CoreClientOptions, "blob" | "url" | "tls" | "bearer"> = {},
  ): CoreClient {
    return new CoreClient({ ...opts, blob });
  }

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  /**
   * Open the link and settle when the Core has said who it is: resolves after
   * `ready` and, when a bearer is configured, after `authOk`.
   *
   * Idempotent **while it is in flight** — a second call returns the first
   * call's promise, so two callers racing to connect share one socket rather
   * than opening two. Once it settles the memo is dropped, and what a later
   * call gets is the state of the link *now*: the current connection's info if
   * one is up, and a fresh attempt if none is.
   *
   * That distinction is the whole point. A memo kept past its rejection is a
   * client that reports itself permanently unconnectable — a durable client
   * whose connect deadline expired once would hand every later caller that same
   * rejection long after its supervisor had reconnected, because nothing here
   * ever cleared it (issue 153 review, note 3; #156 builds on this).
   *
   * Rejects on a refused bearer, on a socket that closed before it was
   * established, and on the connect deadline. A {@link DurableCoreClient} keeps
   * retrying underneath regardless; what rejects there is this promise, not the
   * client.
   */
  connect(): Promise<CoreConnectionInfo> {
    if (this.closed) return Promise.reject(new Error("core-link client closed"));
    if (this.connectPromise) return this.connectPromise;
    // A link that is already up answers straight away rather than dialing a
    // second one over a working first.
    if (this.established) return Promise.resolve(this.connectionInfo());
    this.connectPromise = new Promise<CoreConnectionInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failConnect(new Error(`core-link connect to ${this.url} timed out`));
      }, this.connectTimeoutMs);
      this.connectSettle = { resolve, reject, timer };
    });
    // Dial only when nothing is already dialing on this client's behalf. A
    // transport mid-handshake, or a durable client's backoff timer about to make
    // one, will settle the promise above through the ordinary handlers — opening
    // another socket here would orphan whichever of the two lost the race.
    if (!this.transport && !this.reconnectScheduled()) this.openTransport();
    return this.connectPromise;
  }

  /**
   * Is a reconnect already pending, so `connect()` must not dial itself? Never
   * for a one-shot client, which has no supervisor; {@link DurableCoreClient}
   * overrides it with its backoff timer.
   */
  protected reconnectScheduled(): boolean {
    return false;
  }

  /**
   * Open one connection and wire it to this client. The transport is per socket;
   * every listener above is per client, which is what lets a durable subclass
   * replace the former without anything above noticing.
   */
  protected openTransport(): void {
    if (this.closed) return;
    this.ready = null;
    this.multiConnection = null;
    this.authOkFrame = null;
    this.established = false;
    this.transport = new CoreLinkTransport({
      url: this.url,
      createSocket: this.createSocket,
      bearer: this.bearer,
      heartbeat: this.heartbeat,
      handlers: {
        onReady: (frame) => {
          this.ready = frame;
          this.multiConnection = readMultiConnectionCapability(frame.multiConnection);
          const info = this.connectionInfo();
          for (const cb of this.readyListeners) cb(info);
          this.maybeEstablish();
        },
        onWritable: () => {
          // Writability alone does not drain the queue. `maybeEstablish` flushes
          // it once the connection is established, *behind* what that connection
          // owed the Core — and on the no-bearer path writability lands before
          // `ready`, so flushing here regardless would put a caller's request on
          // the wire ahead of `reclaim` and `subscribe`, which is the ordering
          // the comment on `onConnectionEstablished` promises callers. The guard
          // covers the case where writability returns on a connection that is
          // already established.
          this.maybeEstablish();
          if (this.established) this.flushQueue();
        },
        onAuthOk: (frame) => {
          this.authOkFrame = frame;
          for (const cb of this.authOkListeners) cb({ coreId: frame.coreId, exp: frame.exp });
        },
        onAuthError: (reason) => {
          for (const cb of this.authErrorListeners) cb({ reason });
          this.failConnect(new CoreLinkAuthError(reason));
        },
        onData: (frame) => {
          for (const cb of this.dataListeners) cb(frame);
        },
        onExit: (frame) => {
          for (const cb of this.exitListeners) cb(frame);
        },
        onEvent: (event) => this.deliverEvent(event),
        onEventsReplayed: (lastEventId) => this.deliverEventsReplayed(lastEventId),
        onClose: (reason) => {
          this.ready = null;
          this.multiConnection = null;
          this.authOkFrame = null;
          // Cleared here and not only on the next dial: between a socket dying
          // and a durable client's backoff opening the next one, this client is
          // not established, and a `connect()` arriving in that gap must wait
          // for the connection that is coming rather than be told about the one
          // that just died.
          this.established = false;
          this.transport = null;
          this.failInFlight();
          for (const cb of this.disconnectedListeners) cb({ error: reason });
          this.onConnectionClosed(reason);
        },
      },
    });
  }

  /**
   * The connection is up, authenticated if it had to be, and the capability off
   * `ready` is known. What a fresh connection owes the Core goes here.
   *
   * `reclaim` is the whole of it for a one-shot client, and it is fire-and-forget
   * by design (ADR 0024 D9): nothing waits on the answer, because the locks have
   * already moved by the time it is written, and a reclaim that never lands costs
   * the 45-second heartbeat timeout it was shortening — a slower path to the same
   * state, never a wrong one.
   *
   * Overridden by {@link DurableCoreClient}, which owes the Core rather more.
   */
  protected onConnectionEstablished(): void {
    this.sendReclaim();
  }

  /**
   * Establish the connection once both halves of "established" are true: the
   * Core has said who it is (`ready`), and the link can be written to (open, and
   * authenticated when a bearer was configured).
   *
   * **Whichever lands last is what triggers it**, and that is not a fixed order.
   * With a bearer it is `authOk`, well after `ready`. Without one, writability
   * rides the socket opening and `ready` normally follows — but a Core that got
   * its frame in first would otherwise have the connection's opening frames sent
   * against a socket that is not writable yet, and a `subscribe` dropped there is
   * a client that never receives an event again. Waiting for both removes the
   * ordering assumption instead of relying on it.
   */
  private maybeEstablish(): void {
    if (this.established || this.closed) return;
    if (!this.ready || !this.transport?.writable) return;
    this.established = true;
    this.onConnectionEstablished();
    // The queue goes out behind what the connection owed the Core, so a replay
    // tail is delivered ahead of the answers to requests that were waiting.
    this.flushQueue();
    this.settleConnect();
  }

  /** The socket is gone. A one-shot client is done; a durable one reconnects. */
  protected onConnectionClosed(reason?: string): void {
    if (this.closed) return;
    this.failConnect(new Error(reason ? `core-link closed: ${reason}` : "core-link closed"));
  }

  private settleConnect(): void {
    const settle = this.connectSettle;
    if (!settle) return;
    this.connectSettle = null;
    this.connectPromise = null;
    clearTimeout(settle.timer);
    settle.resolve(this.connectionInfo());
  }

  private failConnect(err: Error): void {
    const settle = this.connectSettle;
    if (!settle) return;
    this.connectSettle = null;
    // Dropped on failure as well as on success: a rejected promise held in the
    // memo would be handed to every later caller forever. See `connect()`.
    this.connectPromise = null;
    clearTimeout(settle.timer);
    settle.reject(err);
  }

  /** What the current connection said about itself. */
  connectionInfo(): CoreConnectionInfo {
    return {
      protocolVersion: this.ready?.version ?? null,
      compatible: coreLinkProtocolCompatible(this.ready?.version ?? null),
      multiConnection: this.multiConnection,
      coreId: this.authOkFrame?.coreId ?? null,
      bearerExpiresAt: this.authOkFrame?.exp ?? null,
    };
  }

  /** True once the Core has accepted this connection's bearer. */
  isAuthenticated(): boolean {
    return this.transport?.isAuthenticated ?? false;
  }

  /** True while a link is up and able to carry a frame. */
  isConnected(): boolean {
    return this.transport?.writable ?? false;
  }

  /**
   * May this Core be sent frames only a multi-connection Core understands — the
   * Session lock's `claim`, the per-connection PTY subscription, and whatever
   * else lands under ADR 0024?
   *
   * **The one predicate to consult before sending any such frame.** False means
   * do not send it: not send-and-handle-the-error, not send-and-hope. The Core on
   * the other end is a single-connection build that would answer an unknown frame
   * with an error frame at best, and the caller is expected to have a
   * single-connection path already — that path is what shipped before this
   * capability existed.
   *
   * False before `ready` lands and after a drop, for as long as the answer is
   * unknown. A caller that needs the capability at startup awaits
   * {@link connect}, whose answer carries it, rather than reading this on the
   * first tick.
   */
  canSendMultiConnectionFrames(): boolean {
    return this.multiConnection !== null;
  }

  /**
   * This connection's `multiConnection` capability, or null. For callers that
   * need the version rather than the yes/no — the gate is
   * {@link canSendMultiConnectionFrames}.
   */
  multiConnectionCapability(): CoreLinkMultiConnectionCapability | null {
    return this.multiConnection;
  }

  /** Hang up. Rejects every outstanding request; fires no `onDisconnected`. */
  close(): void {
    this.closed = true;
    const err = new Error("core-link client closed");
    for (const entry of [...this.queue, ...this.inFlight]) this.settle(entry, () => entry.reject(err));
    this.queue.length = 0;
    this.inFlight.clear();
    this.failConnect(err);
    this.transport?.close();
    this.transport = null;
  }

  // ─── Requests ──────────────────────────────────────────────────────────────

  /**
   * Send any core-link request frame and resolve with the Core's raw response
   * frame — errors included, as frames rather than rejections.
   *
   * This is the seam a router forwards through. A router that had to go through
   * the typed methods below would unwrap each response only to re-wrap it, and
   * would have to invent a shape for the failures those methods turn into
   * rejections. Handing it the frame keeps it a router rather than a translator.
   *
   * The `reqId` on the frame passed in is ignored — the transport owns
   * correlation on its own socket, and the returned frame carries the id it
   * assigned. A caller matching answers to its own callers (the Panel does,
   * across many browsers) keys on its own id and rewrites it on the way back.
   *
   * A frame issued while no link is up is **queued, not refused**: it goes out
   * when one comes up, or its deadline ends it. That is what makes a call made
   * during a reconnect work rather than needing every call site to retry.
   */
  request(
    frame: CoreLinkRequestFrame,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<CoreLinkResponseFrame> {
    if (this.closed) return Promise.reject(new Error("core-link client closed"));
    // The gate (ADR 0024 D11). A multi-connection-only frame aimed at a Core
    // that never announced the capability is refused here, before anything
    // reaches the socket — the Core never sees it, so there is no error frame to
    // tolerate. The rejection is for the caller that asked without checking; the
    // supported path is to consult `canSendMultiConnectionFrames()` and take the
    // single-connection route.
    if (this.multiConnectionOnlyFrameTypes.has(frame.type) && !this.canSendMultiConnectionFrames()) {
      return Promise.reject(
        new Error(
          `core-link frame ${frame.type} needs the multiConnection capability, which this Core does not announce`,
        ),
      );
    }
    return new Promise<CoreLinkResponseFrame>((resolve, reject) => {
      const entry: PendingRequest = { frame, resolve, reject, timer: null, settled: false };
      entry.timer = setTimeout(() => {
        this.forget(entry);
        this.settle(entry, () =>
          reject(new Error(`core-link rpc ${frame.type} timed out`)),
        );
      }, timeoutMs);
      this.dispatch(entry);
    });
  }

  /** Send now if there is a link, otherwise hold it for the next one. */
  private dispatch(entry: PendingRequest): void {
    const transport = this.transport;
    if (!transport?.writable) {
      this.queue.push(entry);
      return;
    }
    this.inFlight.add(entry);
    transport.request(entry.frame).then(
      (response) => {
        this.inFlight.delete(entry);
        this.settle(entry, () => entry.resolve(response));
      },
      (err: Error) => {
        this.inFlight.delete(entry);
        this.settle(entry, () => entry.reject(err));
      },
    );
  }

  /** Drain what was waiting for a link, in the order it was asked for. */
  private flushQueue(): void {
    if (this.queue.length === 0) return;
    const queued = this.queue.splice(0);
    for (const entry of queued) {
      if (entry.settled) continue;
      this.dispatch(entry);
    }
  }

  /**
   * Fail every request that was on the wire when the socket died. Their replies
   * can never arrive, so leaving them pending only makes a caller wait out its
   * whole deadline before it can retry on the next connection.
   */
  private failInFlight(): void {
    if (this.inFlight.size === 0) return;
    const err = new Error("core-link connection lost");
    const entries = [...this.inFlight];
    this.inFlight.clear();
    for (const entry of entries) this.settle(entry, () => entry.reject(err));
  }

  private forget(entry: PendingRequest): void {
    this.inFlight.delete(entry);
    const at = this.queue.indexOf(entry);
    if (at >= 0) this.queue.splice(at, 1);
  }

  private settle(entry: PendingRequest, finish: () => void): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    finish();
  }

  /** Send a request and unwrap the Core's answer into the value it carries. */
  protected rpc(frame: CoreLinkRequestFrame, timeoutMs?: number): Promise<unknown> {
    return this.request(frame, timeoutMs).then((response) => unwrapResponse(response));
  }

  /**
   * Send a fire-and-forget frame on the current connection. False when there is
   * no writable connection to put it on — for the frames whose answer is a
   * stream and whose retry is the next connection re-sending them anyway.
   */
  protected sendNow(frame: CoreLinkRequestFrame, reqIdPrefix?: string): boolean {
    const transport = this.transport;
    if (!transport) return false;
    return transport.send(frame, reqIdPrefix) !== null;
  }

  /**
   * Present this client's Core client id, so the Core closes the socket this
   * connection replaces and moves its Session locks here (ADR 0024 D9).
   *
   * The answer is not discarded, though (issue 147). `taskIds` names the Sessions
   * whose locks came across, and that is a fact no layer above can derive: this
   * connection did not claim them, the Core logged no event for the transfer —
   * the locks moved in place, which is exactly the atomicity D9 needs — so until
   * something asks for a fresh snapshot nothing else on the link says this client
   * is holding them again. Hence {@link onReclaimed}.
   *
   * **Against a Core that does not announce `multiConnection`, this sends
   * nothing** — the same consult-the-gate-and-degrade shape
   * {@link ptySubscribe} and {@link claim} take, and here the degraded behaviour
   * is not merely acceptable but identical: such a Core evicts the previous
   * connection when this one opens, which is precisely what the frame asks for.
   */
  protected sendReclaim(): void {
    if (!this.canSendMultiConnectionFrames()) return;
    void this.rpc({ type: "reclaim", reqId: "", clientId: this.clientId })
      .then((result) => {
        const answer = result as { replaced?: boolean; taskIds?: string[] } | undefined;
        if (!answer) return;
        const msg = {
          replaced: answer.replaced === true,
          taskIds: Array.isArray(answer.taskIds) ? answer.taskIds : [],
        };
        for (const cb of this.reclaimedListeners) {
          try {
            cb(msg);
          } catch {
            /* a listener's failure is not this connection's failure */
          }
        }
      })
      .catch(() => {
        /* the socket died again; the next connection presents the same id */
      });
  }

  // ─── The three unsolicited streams, plus the event log ─────────────────────

  /**
   * One PTY's bytes, as the transport parsed them. Nothing above re-parses a raw
   * message: this is the frame, typed against the SDK's own schema.
   *
   * A Core sends a PTY's `data` only to the connections that asked for it, so
   * {@link ptySubscribe} is what makes this fire at all against a
   * multi-connection Core.
   */
  onData(cb: (frame: CoreLinkDataFrame) => void): Unsubscribe {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  /** One PTY's exit, on the same terms as {@link onData}. */
  onExit(cb: (frame: CoreLinkExitFrame) => void): Unsubscribe {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  /**
   * Notified on every connection's `ready` frame with what the Core says about
   * itself — the protocol version, whether this build speaks it, and the
   * `multiConnection` capability. Fires on every (re)connect, so a Core that
   * comes back after an update reports itself compatible with no extra plumbing.
   */
  onReady(cb: (info: CoreConnectionInfo) => void): Unsubscribe {
    this.readyListeners.add(cb);
    return () => this.readyListeners.delete(cb);
  }

  /**
   * Domain events off the Core's monotonic log — task status, hooks, session
   * finish, PTY lifecycle. A one-shot client receives only what arrives while it
   * is connected; the cursor, the replay and the dedupe that make a *gap*
   * recoverable are {@link DurableCoreClient}'s.
   */
  onEvent(cb: (msg: { event: CoreLinkEvent }) => void): Unsubscribe {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /**
   * Ask this Core for its event log: the tail past `lastEventId`, then live
   * push for as long as this connection lasts.
   *
   * Fire-and-forget, because the answer is a *stream* — the replay tail as
   * `event` frames and the {@link onEventsReplayed} marker behind them — rather
   * than a reqId-correlated response. Returns false when there was no writable
   * connection to put the frame on.
   *
   * A one-shot client sends this only if it is asked to. That is the difference
   * between the two entry points here: {@link DurableCoreClient} owes the Core a
   * subscribe on every connection and sends one through this method, whereas a
   * program that connects to ask one question wants no event stream at all.
   * What made it public is the session layer (issue 155): a script that starts a
   * Session and waits for the harness to finish is reading the Core's own
   * report of that, and the report is an event.
   *
   * `lastEventId` defaults to 0, which asks for the whole tail the Core will
   * serve. That is the honest default for a caller with no cursor — the
   * alternative is inventing a high-water mark, and a cursor that runs ahead of
   * the log stops live push entirely. A caller that keeps a cursor passes it.
   */
  subscribeEvents(lastEventId = 0): boolean {
    if (this.closed) return false;
    this.eventsSubscribed = true;
    return this.sendNow({ type: "subscribe", reqId: "", lastEventId }, "sub");
  }

  /**
   * Has a `subscribe` gone out on this client's behalf?
   *
   * For a caller that needs the event stream but does not know whether the
   * client it was handed is already receiving one — a durable client subscribes
   * itself, a one-shot client does not, and a second subscribe would replay the
   * tail a second time.
   */
  isSubscribedToEvents(): boolean {
    return this.eventsSubscribed;
  }

  /** Notified when a `subscribe` replay tail has been fully streamed. */
  onEventsReplayed(cb: (msg: { lastEventId: number }) => void): Unsubscribe {
    this.eventsReplayedListeners.add(cb);
    return () => this.eventsReplayedListeners.delete(cb);
  }

  /**
   * Notified once per connection when the Core accepts the bearer. `exp` is the
   * session expiry — a caller can hint "session expires at".
   */
  onAuthOk(cb: (msg: { coreId: string; exp: number }) => void): Unsubscribe {
    this.authOkListeners.add(cb);
    return () => this.authOkListeners.delete(cb);
  }

  /**
   * Notified when the Core refuses the bearer. The Core closes the socket right
   * after; an expired bearer keeps failing until a reissued blob is pasted (ADR
   * 0003).
   */
  onAuthError(cb: (msg: { reason: CoreLinkAuthErrorReason }) => void): Unsubscribe {
    this.authErrorListeners.add(cb);
    return () => this.authErrorListeners.delete(cb);
  }

  /**
   * Notified whenever the socket goes down — a dropped connection, a Core
   * restart, a dial that never completed. `close()` does not fire it: that is
   * this client hanging up, not the Core going away.
   */
  onDisconnected(cb: (msg: { error?: string }) => void): Unsubscribe {
    this.disconnectedListeners.add(cb);
    return () => this.disconnectedListeners.delete(cb);
  }

  /**
   * What this client's `reclaim` reaped, once per connection that sent one (ADR
   * 0024 D9, issue 147 is its consumer).
   *
   * Fires only on a Core that announces `multiConnection`, because only such a
   * Core is sent the frame at all. `taskIds` is often empty and an empty list
   * never means the id was unknown — it means this client held nothing when its
   * previous socket went quiet, which is the ordinary case.
   */
  onReclaimed(cb: (msg: { replaced: boolean; taskIds: string[] }) => void): Unsubscribe {
    this.reclaimedListeners.add(cb);
    return () => this.reclaimedListeners.delete(cb);
  }

  /** Hand one event to the listeners. Overridden where a cursor is kept. */
  protected deliverEvent(event: CoreLinkEvent): void {
    for (const cb of this.eventListeners) cb({ event });
  }

  /** Hand the end-of-replay marker on. Overridden where a cursor is kept. */
  protected deliverEventsReplayed(lastEventId: number): void {
    for (const cb of this.eventsReplayedListeners) cb({ lastEventId });
  }

  // ─── Typed frame methods ───────────────────────────────────────────────────

  spawn(opts: CoreLinkPtySpawnOptions): Promise<{ ptyId: string }> {
    return this.rpc({ type: "spawn", reqId: "", opts }) as Promise<{ ptyId: string }>;
  }

  write(ptyId: string, data: string): Promise<boolean> {
    return this.rpc({ type: "write", reqId: "", ptyId, data }) as Promise<boolean>;
  }

  resize(ptyId: string, cols: number, rows: number): Promise<boolean> {
    return this.rpc({ type: "resize", reqId: "", ptyId, cols, rows }) as Promise<boolean>;
  }

  kill(ptyId: string): Promise<boolean> {
    return this.rpc({ type: "kill", reqId: "", ptyId }) as Promise<boolean>;
  }

  killLaunchProcesses(opts: {
    cwd: string;
    commands: string[];
    ports?: number[];
  }): Promise<CoreLinkLaunchProcessKillResult> {
    return this.rpc({
      type: "killLaunchProcesses",
      reqId: "",
      cwd: opts.cwd,
      commands: opts.commands,
      ports: opts.ports,
    }) as Promise<CoreLinkLaunchProcessKillResult>;
  }

  findByTask(taskId: string): Promise<{ ptyId: string | null }> {
    return this.rpc({ type: "findByTask", reqId: "", taskId }) as Promise<{ ptyId: string | null }>;
  }

  /**
   * See {@link CoreLinkRequestFrame} `replay` — `sinceSeq` asks for the tail past
   * a cursor (a reattach); omitting it asks for the whole scrollback.
   */
  replay(ptyId: string, sinceSeq?: number): Promise<CoreLinkPtyReplay> {
    return this.rpc({ type: "replay", reqId: "", ptyId, sinceSeq }) as Promise<CoreLinkPtyReplay>;
  }

  /**
   * Ask this Core for one PTY's byte stream (ADR 0024 D2). Until a client
   * subscribes, {@link onData}/{@link onExit} never fire for that `ptyId` — a
   * Core fans output out to the connections that asked and to no others.
   *
   * `catchUp` says a `replay` for this PTY follows and the Core must hold the
   * live stream until it has been served, so the caller never paints live bytes
   * in front of its own scrollback. A caller that sets it owes that replay;
   * nothing else releases the hold.
   *
   * **Against a Core that does not announce `multiConnection`, this sends nothing
   * and resolves** (ADR 0024 D11). That is the deliberate single-connection
   * fallback, not a swallowed failure: such a Core fans every PTY out to every
   * connection, so the caller is already receiving the bytes it just asked for,
   * and the subscription it would send is a frame that Core has no vocabulary
   * for. Resolving says what is true — this client renders that PTY — which is
   * the only thing the caller acts on.
   */
  ptySubscribe(ptyId: string, opts: { catchUp?: boolean } = {}): Promise<void> {
    if (!this.canSendMultiConnectionFrames()) return Promise.resolve();
    return this.rpc({
      type: "ptySubscribe",
      reqId: "",
      ptyId,
      catchUp: opts.catchUp === true,
    }).then(() => undefined);
  }

  /**
   * Stop receiving one PTY's stream. Same fallback as {@link ptySubscribe}, for
   * the same reason: against a capability-less Core there is no subscription to
   * drop, because its fan-out is unconditional and cannot be narrowed by a frame
   * it does not know.
   */
  ptyUnsubscribe(ptyId: string): Promise<void> {
    if (!this.canSendMultiConnectionFrames()) return Promise.resolve();
    return this.rpc({ type: "ptyUnsubscribe", reqId: "", ptyId }).then(() => undefined);
  }

  /**
   * Take this Session's write lock (ADR 0024 D6).
   *
   * `granted: false` means another Core client holds it — an answer, not a
   * failure, and the only way past it is {@link forceTakeover}. Idempotent for a
   * client that already holds the Session.
   *
   * **Against a Core that does not announce `multiConnection`, this sends nothing
   * and answers `{ supported: false, granted: false }`.** Such a Core evicts
   * every client but one, so there is nothing for a lock to arbitrate between and
   * no table to put a claim in.
   *
   * `supported: false` must never be rendered as read-only. It says this Core has
   * no Session lock at all, so every mutation this client makes will be served —
   * the opposite of what `granted: false` says. A caller that treats the two the
   * same makes a single-connection Core look permanently locked to an operator
   * who is in fact its only client.
   */
  claim(taskId: string): Promise<{ supported: boolean; granted: boolean }> {
    if (!this.canSendMultiConnectionFrames()) {
      return Promise.resolve({ supported: false, granted: false });
    }
    return this.rpc({ type: "claim", reqId: "", taskId }).then((granted) => ({
      supported: true,
      granted: granted === true,
    }));
  }

  /**
   * Give this Session's write lock back (ADR 0024 D7).
   *
   * `released: false` means this client did not hold it — idempotent, not an
   * error, so a caller releasing on teardown does not have to know whether it had
   * already lost the lock to a takeover. Same capability fallback as
   * {@link claim}: nothing goes on the wire to a Core with no lock table, and
   * `supported: false` says there was never a lock to give back.
   */
  release(taskId: string): Promise<{ supported: boolean; released: boolean }> {
    if (!this.canSendMultiConnectionFrames()) {
      return Promise.resolve({ supported: false, released: false });
    }
    return this.rpc({ type: "release", reqId: "", taskId }).then((released) => ({
      supported: true,
      released: released === true,
    }));
  }

  /**
   * Take this Session's write lock whoever holds it (ADR 0024 D7).
   *
   * The answer to a hung client, and the reason the lock needs no idle timeout.
   * Unrecoverable by design: the previous holder's in-flight keystrokes are gone
   * and its next mutation is refused. `takenFrom` names who lost it so a caller
   * can say so rather than infer it — taking an unheld Session is an ordinary
   * claim by another name.
   *
   * Same capability fallback as {@link claim}, answering `takenFrom: "nobody"`:
   * there was nobody to take it from, because there is no lock on such a Core to
   * take.
   */
  forceTakeover(
    taskId: string,
  ): Promise<{ supported: boolean; takenFrom: CoreLinkSessionTakenFrom }> {
    if (!this.canSendMultiConnectionFrames()) {
      return Promise.resolve({ supported: false, takenFrom: "nobody" });
    }
    return this.rpc({ type: "forceTakeover", reqId: "", taskId }).then((takenFrom) => ({
      supported: true,
      takenFrom: (takenFrom ?? "nobody") as CoreLinkSessionTakenFrom,
    }));
  }

  /**
   * List every project on this Core as a live snapshot. The Core is the source of
   * truth; a client holds none. The returned `path` is a machine path on the
   * Core — only the Core can validate it.
   */
  projectsList(): Promise<CoreLinkProjectSnapshot[]> {
    return this.rpc({ type: "projectsList", reqId: "" }) as Promise<CoreLinkProjectSnapshot[]>;
  }

  /**
   * List every active (non-archived) task on this Core, optionally filtered to
   * one project.
   *
   * `archivedCount` is how many archived rows the same scope holds — a scalar,
   * never the rows (ADR 0019). Use {@link archivedTasksList} for those.
   */
  tasksList(projectId?: string): Promise<{ tasks: CoreLinkTaskSnapshot[]; archivedCount: number }> {
    return this.rpc({ type: "tasksList", reqId: "", projectId }) as Promise<{
      tasks: CoreLinkTaskSnapshot[];
      archivedCount: number;
    }>;
  }

  /**
   * List every archived task on this Core, optionally filtered to one project
   * (ADR 0019) — a separate frame from {@link tasksList}, so an active answer
   * stays free of archived rows by construction rather than by what a caller
   * remembers to pass.
   */
  archivedTasksList(projectId?: string): Promise<CoreLinkTaskSnapshot[]> {
    return this.rpc({ type: "archivedTasksList", reqId: "", projectId }) as Promise<
      CoreLinkTaskSnapshot[]
    >;
  }

  /**
   * Create / rename / archive a project on this Core. The Core validates the
   * machine path server-side; an invalid path comes back as an `error` frame that
   * rejects this promise. Returns `null` when a `rename`/`archive` targets a
   * missing row.
   */
  projectsMutate(mutation: CoreLinkProjectMutation): Promise<CoreLinkProjectSnapshot | null> {
    return this.rpc({ type: "projectsMutate", reqId: "", mutation }) as Promise<
      CoreLinkProjectSnapshot | null
    >;
  }

  /** Create / update / delete a task. Returns `null` when it targets a missing row. */
  tasksMutate(mutation: CoreLinkTaskMutation): Promise<CoreLinkTaskSnapshot | null> {
    return this.rpc({ type: "tasksMutate", reqId: "", mutation }) as Promise<
      CoreLinkTaskSnapshot | null
    >;
  }

  /**
   * List every active session on this Core (optionally filtered to one project).
   * A session's `ptyId` is set when the Core has a live PTY for that task — which
   * is how a client knows what it can reattach to.
   */
  sessionsList(projectId?: string): Promise<CoreLinkSessionSnapshot[]> {
    return this.rpc({ type: "sessionsList", reqId: "", projectId }) as Promise<
      CoreLinkSessionSnapshot[]
    >;
  }

  /**
   * Snapshot of this Core's CLI availability. Live updates arrive as
   * `agents:availabilityChanged` events on {@link onEvent}; this is how a client
   * hydrates without waiting for the next probe tick.
   */
  agentsAvailabilityList(): Promise<CoreLinkHarnessAvailabilityMap> {
    return this.rpc({ type: "agentsAvailabilityList", reqId: "" }) as Promise<
      CoreLinkHarnessAvailabilityMap
    >;
  }
}

/**
 * Turn a response frame into the value the typed methods promise, or throw the
 * failure it carries. The two failure frames (`spawnError`, `error`) become
 * rejections here so a caller of `spawn()` sees an exception rather than a frame
 * it has to inspect; {@link CoreClient.request} bypasses this and hands the frame
 * over untouched.
 */
export function unwrapResponse(msg: CoreLinkResponseFrame): unknown {
  switch (msg.type) {
    case "spawned":
      return { ptyId: msg.ptyId };
    case "spawnError":
      throw new Error(msg.message);
    case "writeResult":
    case "resizeResult":
    case "killResult":
      return msg.ok;
    case "killLaunchProcessesResult":
      return msg.result;
    case "findByTaskResult":
      return { ptyId: msg.ptyId };
    case "replayResult":
      return { data: msg.data, nextSeq: msg.nextSeq, from: msg.from };
    // The active list answers with rows *and* the archived count (ADR 0019), so
    // unwrapping to `msg.tasks` alone would drop a required field of the frame.
    // The archived list carries rows only.
    case "tasksListResult":
      return { tasks: msg.tasks, archivedCount: msg.archivedCount };
    case "archivedTasksListResult":
      return msg.tasks;
    case "projectsListResult":
      return msg.projects;
    case "tasksMutateResult":
      return msg.task;
    case "projectsMutateResult":
      return msg.project;
    case "sessionsListResult":
      return msg.sessions;
    case "agentsAvailabilityListResult":
      return msg.availability;
    case "ptySubscribeAck":
    case "ptyUnsubscribeAck":
      return { ptyId: msg.ptyId, subscribed: msg.subscribed };
    // The Session lock's three answers unwrap to the one field each carries
    // beyond the taskId the caller already passed in (issue 144). A denied claim
    // comes back here as `false` rather than as a rejection — it is an answer,
    // not a failure, and only a *mutation* refused for the lock throws (that is
    // an `error` frame, below, carrying `session-locked`).
    case "claimResult":
      return msg.granted;
    case "releaseResult":
      return msg.released;
    case "forceTakeoverResult":
      return msg.takenFrom;
    // Both fields, because both are reporting a caller cannot derive (issue 146).
    // `taskIds` in particular is the set of Sessions whose locks came across with
    // this connection, and a lock register is its consumer: after a reconnect
    // those Sessions are held-by-you again, and nothing else on the link would
    // say so until the next snapshot.
    case "reclaimResult":
      return { replaced: msg.replaced, taskIds: msg.taskIds };
    // The code rides the rejection rather than being dropped at the boundary
    // (issue 144): a caller can already tell "locked" (throws) from "gone"
    // (resolves), and this is what lets it tell "locked" from any other error
    // without reading the prose the field exists to spare it.
    case "error":
      throw new CoreLinkRequestError(msg.message, msg.code);
    default:
      // `ready`, `subscribeAck`, the auth frames — not request/response answers
      // any typed method awaits. Resolving undefined matches the Panel's
      // behaviour of leaving such a frame unhandled rather than rejecting on it.
      return undefined;
  }
}
