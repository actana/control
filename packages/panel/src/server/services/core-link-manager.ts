import { DurableCoreClient } from "@actana/sdk/durable-core-client";
import {
  advanceCoreCursor,
  getCore,
  getCoreCursor,
  getCoreSecrets,
  listCores,
  type CoreSecrets,
} from "./cores";
import type { Core, CoreDialStatus } from "~/shared/cores";
import {
  CORE_LINK_PROTOCOL_VERSION,
  type CoreLinkEvent,
  type CoreLinkFilesCapability,
  type CoreLinkRequestFrame,
  type CoreLinkResponseFrame,
} from "@actana/sdk/core-link-frames";

/**
 * The Panel service's core-links: one dialed connection per registered Core,
 * held for the life of the process.
 *
 * This is the piece that makes the Panel a service rather than a window. The
 * links are the service's, not a browser's — they come up at boot, they stay
 * up while nobody is logged in, and closing every tab costs nothing. That is
 * also why the replay cursor is the registry's: events arrive whether or not a
 * browser is watching, and a cursor that only moved while a tab was open would
 * make every reconnect replay the hours it slept through.
 */

/**
 * The slice of the core-link client this manager drives, and hands on to the
 * panel-link router. Structural, so a test fake satisfies it.
 *
 * The manager itself only needs the lifecycle half (auth/disconnect/close);
 * the request and stream halves are here because the manager is what owns the
 * clients, so it is also what can hand one to the router that fans a Core's
 * traffic out to the browsers watching it.
 */
export interface CoreLinkClientLike {
  onAuthOk(cb: (msg: { coreId: string; exp: number }) => void): () => void;
  onAuthError(cb: (msg: { reason: "expired" | "bad-signature" | "malformed" }) => void): () => void;
  onDisconnected(cb: (msg: { error?: string }) => void): () => void;
  /**
   * Every connection's `ready` frame: which core-link the Core speaks, and
   * which optional capabilities came with it.
   *
   * `files` is optional on the message rather than required (#129 F9): a fake
   * that predates the capability emits two fields and means "this Core
   * announced none", which is the same thing a real Core omitting it means.
   */
  onProtocolVersion(
    cb: (msg: {
      version: string | null;
      compatible: boolean;
      files?: CoreLinkFilesCapability | null;
    }) => void,
  ): () => void;
  /** Forward any core-link request frame; resolves with the raw answer frame. */
  request(frame: CoreLinkRequestFrame, timeoutMs?: number): Promise<CoreLinkResponseFrame>;
  onData(cb: (msg: { ptyId: string; data: string; seq: number }) => void): () => void;
  onExit(cb: (msg: { ptyId: string; exitCode: number; signal?: number }) => void): () => void;
  onEvent(cb: (msg: { event: CoreLinkEvent }) => void): () => void;
  /**
   * Ask this Core for one PTY's byte stream, or stop asking (issue 142, ADR
   * 0024 D2). `onData`/`onExit` fire only for subscribed PTYs.
   *
   * Named methods rather than `request` frames because the link — not the
   * router above it, and certainly not a browser — is the only thing that knows
   * when its socket dropped, and PTY subscriptions are Core-side connection
   * state that has to be re-established when it comes back.
   */
  ptySubscribe(ptyId: string, opts?: { catchUp?: boolean }): Promise<void>;
  ptyUnsubscribe(ptyId: string): Promise<void>;
  /**
   * Does this Core announce `multiConnection` (ADR 0024 D11)? The router reads
   * it to decide whether a Session has a lock to publish and a keyboard to
   * arbitrate at all — against a Core without it, neither exists and the Panel
   * behaves exactly as it did before either did (issue 147).
   */
  canSendMultiConnectionFrames(): boolean;
  /**
   * The Sessions whose locks came across on this link's `reclaim`, once per
   * connect that sent one (issue 146, ADR 0024 D9). Nothing else reports them:
   * the Core rewrites the lock table in place and appends no event, so this is
   * how a reconnected Panel learns it is still holding what it was holding.
   */
  onReclaimed(cb: (msg: { replaced: boolean; taskIds: string[] }) => void): () => void;
  close(): void;
}

/**
 * The Panel-owned replay position, handed to the client at construction. The
 * client reads it when it subscribes (so the Core replays only the missed
 * tail) and writes it back as events land.
 */
export type CoreCursor = {
  read(): number;
  write(lastEventId: number): void;
};

export type CoreLinkManagerOptions = {
  createClient?: (core: Core, secrets: CoreSecrets, cursor: CoreCursor) => CoreLinkClientLike;
  listCores?: () => Core[];
  resolveCore?: (coreId: string) => Core | null;
  resolveSecrets?: (coreId: string) => CoreSecrets | null;
  resolveCursor?: (coreId: string) => number;
  advanceCursor?: (coreId: string, lastEventId: number) => void;
};

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type Managed = {
  client: CoreLinkClientLike | null;
  status: CoreDialStatus;
  /**
   * Set while this Core's last `ready` frame advertised a protocol this Panel
   * cannot speak; `{ version }` is what it advertised (null if it advertised
   * none). Held apart from the status because the auth handshake arrives after
   * the `ready` frame and would otherwise call the Core connected — a Core that
   * needs updating stays needing it until the Core comes back speaking a
   * version we share.
   */
  drift: { version: string | null } | null;
  /**
   * The `files` capability off this link's last `ready` frame (#129 F9), or
   * null. Held beside the status rather than inside it because every `set()`
   * builds a fresh status object and the capability outlives all of them: a
   * Core that goes unreachable and comes back announcing `files` again should
   * not have the answer reset by whichever state transition happened to be
   * last. It is cleared on the next `ready` — which is where it is learnt.
   */
  files: CoreLinkFilesCapability | null;
};

function unreachable(coreId: string, lastSeenAt: number | null, detail?: string): CoreDialStatus {
  return { coreId, state: "unreachable", lastSeenAt, ...(detail ? { detail } : {}) };
}

export class CoreLinkManager {
  private readonly managed = new Map<string, Managed>();
  private readonly statusListeners = new Set<(status: CoreDialStatus) => void>();
  private readonly clientListeners = new Set<(coreId: string, client: CoreLinkClientLike) => void>();
  private readonly createClient: NonNullable<CoreLinkManagerOptions["createClient"]>;
  private readonly listCores: NonNullable<CoreLinkManagerOptions["listCores"]>;
  private readonly resolveCore: NonNullable<CoreLinkManagerOptions["resolveCore"]>;
  private readonly resolveSecrets: NonNullable<CoreLinkManagerOptions["resolveSecrets"]>;
  private readonly resolveCursor: NonNullable<CoreLinkManagerOptions["resolveCursor"]>;
  private readonly advanceCursor: NonNullable<CoreLinkManagerOptions["advanceCursor"]>;

  constructor(opts: CoreLinkManagerOptions = {}) {
    this.createClient = opts.createClient ?? defaultCreateClient;
    this.listCores = opts.listCores ?? listCores;
    this.resolveCore = opts.resolveCore ?? getCore;
    this.resolveSecrets = opts.resolveSecrets ?? getCoreSecrets;
    this.resolveCursor = opts.resolveCursor ?? getCoreCursor;
    this.advanceCursor = opts.advanceCursor ?? advanceCoreCursor;
  }

  /** Bring up a link to every registered Core. Idempotent — safe to call again. */
  start(): void {
    for (const core of this.listCores()) this.dial(core.id);
  }

  /**
   * Dial one Core. A Core with a live client keeps it; one that failed to get
   * a client at all — unreadable credentials, a socket that wouldn't construct
   * — is retried, so a fixed key file or a re-registration doesn't need a
   * process restart to take effect.
   */
  dial(coreId: string): void {
    if (this.managed.get(coreId)?.client) return;
    const core = this.resolveCore(coreId);
    if (!core) return;

    const secrets = this.resolveSecrets(coreId);
    if (!secrets?.bearer) {
      // Either the sealed blob wouldn't open (a data directory restored without
      // its key file) or it was never written. Retrying the socket cannot fix
      // either, so this is an auth error the operator has to act on, not a
      // dropped connection to keep quietly reattempting.
      this.set(coreId, {
        coreId,
        state: "auth-error",
        lastSeenAt: this.lastSeenAt(coreId),
        detail: "this Core's stored credentials could not be read — pair it again",
      });
      return;
    }

    this.set(coreId, { coreId, state: "connecting", lastSeenAt: this.lastSeenAt(coreId) });

    let client: CoreLinkClientLike;
    try {
      client = this.createClient(core, secrets, {
        read: () => this.resolveCursor(coreId),
        write: (lastEventId) => this.advanceCursor(coreId, lastEventId),
      });
    } catch (err) {
      this.set(
        coreId,
        unreachable(coreId, this.lastSeenAt(coreId), err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    this.managed.get(coreId)!.client = client;
    for (const cb of this.clientListeners) cb(coreId, client);

    client.onProtocolVersion(({ version, compatible, files }) => {
      const managed = this.managed.get(coreId);
      if (!managed) return;
      managed.drift = compatible ? null : { version };
      // Read off *this* connection, every connection. A Core that was upgraded
      // into the file surface announces it on the `ready` that follows, and one
      // downgraded out of it stops — either way the next status push carries the
      // current answer rather than the one this link came up with.
      managed.files = files ?? null;
      if (managed.drift) {
        this.set(coreId, this.needsUpdateStatus(coreId, managed.drift));
      } else if (managed.status.state === "needs-update") {
        // The Core was updated and reconnected: whatever it was, it is now
        // a Core like any other. The auth handshake on this connection follows
        // and will move it to connected.
        this.set(coreId, { coreId, state: "connecting", lastSeenAt: this.lastSeenAt(coreId) });
      }
    });
    client.onAuthOk(() => {
      // A Core we cannot speak to is not "connected" just because it let us in.
      const drift = this.managed.get(coreId)?.drift;
      if (drift) {
        this.set(coreId, this.needsUpdateStatus(coreId, drift));
        return;
      }
      this.set(coreId, { coreId, state: "connected", lastSeenAt: Date.now() });
    });
    client.onAuthError(({ reason }) => {
      this.set(coreId, {
        coreId,
        state: "auth-error",
        lastSeenAt: this.lastSeenAt(coreId),
        detail: reason,
      });
    });
    client.onDisconnected(({ error }) => {
      this.set(coreId, unreachable(coreId, this.lastSeenAt(coreId), error));
    });
  }

  /** Drop a Core's link and forget its status — called when a Core is removed. */
  hangup(coreId: string): void {
    const managed = this.managed.get(coreId);
    if (!managed) return;
    this.managed.delete(coreId);
    managed.client?.close();
  }

  /** This Core's link state. An unknown Core reads as unreachable, which is true. */
  status(coreId: string): CoreDialStatus {
    return this.managed.get(coreId)?.status ?? unreachable(coreId, null);
  }

  statuses(): CoreDialStatus[] {
    return [...this.managed.values()].map((m) => m.status);
  }

  /** This Core's live link, if one is up. Null while it is down or unknown. */
  client(coreId: string): CoreLinkClientLike | null {
    return this.managed.get(coreId)?.client ?? null;
  }

  /**
   * Watch every dial-status change. This is how a browser learns a Core went
   * away without polling: the service is the one dialing, so the service is the
   * one that finds out.
   */
  onStatusChange(cb: (status: CoreDialStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /**
   * Watch links coming up, including the ones already up when you subscribe —
   * the router attaches at some arbitrary point in the process's life and must
   * not miss the Cores dialed at boot.
   */
  onClient(cb: (coreId: string, client: CoreLinkClientLike) => void): () => void {
    for (const [coreId, managed] of this.managed) {
      if (managed.client) cb(coreId, managed.client);
    }
    this.clientListeners.add(cb);
    return () => this.clientListeners.delete(cb);
  }

  dispose(): void {
    for (const managed of this.managed.values()) managed.client?.close();
    this.managed.clear();
    this.statusListeners.clear();
    this.clientListeners.clear();
  }

  private lastSeenAt(coreId: string): number | null {
    return this.managed.get(coreId)?.status.lastSeenAt ?? null;
  }

  /**
   * Stamp the announced capabilities onto every status this manager publishes,
   * in one place.
   *
   * Every caller of `set` builds a status from the transition it just saw and
   * knows nothing about `ready`. Threading the capability through all of them
   * would mean nine call sites that each have to remember it, and the one that
   * forgot would silently take a Core's Files view away on an unrelated blink.
   */
  private set(coreId: string, status: CoreDialStatus): void {
    const managed = this.managed.get(coreId);
    const stamped: CoreDialStatus = { ...status, files: managed?.files ?? null };
    if (managed) managed.status = stamped;
    else this.managed.set(coreId, { client: null, status: stamped, drift: null, files: null });
    for (const cb of this.statusListeners) cb(stamped);
  }

  /**
   * This Core's announced `files` capability (#129 F9), or null.
   *
   * Read by the file proxy before it sends anything: a Core that announced no
   * file surface is refused here rather than at a `404` from a Core that simply
   * predates it, which is the same order the SDK checks in.
   */
  filesCapability(coreId: string): CoreLinkFilesCapability | null {
    return this.managed.get(coreId)?.files ?? null;
  }

  /**
   * The "this Core is a chore" status: the link is up, but the vocabulary is
   * not shared. `detail` names both versions so the Fleet view can say what
   * drifted without a second round-trip.
   */
  private needsUpdateStatus(coreId: string, drift: { version: string | null }): CoreDialStatus {
    const coreVersion = drift.version;
    return {
      coreId,
      state: "needs-update",
      lastSeenAt: this.lastSeenAt(coreId),
      detail: `this Core speaks core-link ${coreVersion ?? "an older protocol"}; this Panel speaks ${CORE_LINK_PROTOCOL_VERSION}`,
      coreVersion,
      panelVersion: CORE_LINK_PROTOCOL_VERSION,
    };
  }
}

/**
 * One link to one Core: the SDK's durable Core client, dialed (#156, #129 D1).
 *
 * The Panel keeps no client of its own any more. `DurableCoreClient` is that
 * client — it *is* the Panel's, extracted (issue 153) — and everything this
 * manager used to configure it with is configured on it here: the same backoff
 * window, the same heartbeat cadence by default, the same registry-backed
 * cursor, the same bearer and pinned cert material.
 *
 * The dial happens where it always did, at construction. The SDK made
 * connecting explicit because a one-shot client wants to await it; nothing
 * above here does, so the promise is started and its failures dropped — a
 * refused bearer arrives on `onAuthError` and a dead Core on `onDisconnected`,
 * which is where this manager has always read them, and the client keeps
 * reconnecting underneath either way. Awaiting it here would make `dial()`
 * asynchronous for no reader.
 */
function defaultCreateClient(
  core: Core,
  secrets: CoreSecrets,
  cursor: CoreCursor,
): CoreLinkClientLike {
  const client = new DurableCoreClient({
    url: core.endpoint,
    // The mTLS material the SDK's own Node dial presents (ADR 0002). The Panel
    // service is what holds it, and terminates every core link for exactly that
    // reason: no browser WebSocket can present a client certificate (ADR 0012).
    tls: { ca: secrets.caCert, cert: secrets.clientCert, key: secrets.clientKey },
    bearer: secrets.bearer,
    // Keeps this link identifiable as the Panel's on the Core it reclaims from
    // (ADR 0024 D9). The SDK mints `sdk-…` by default, which is the honest name
    // for a client it knows nothing else about; this Core client has a name, it
    // has always presented it, and once the CLI ships on the same package the
    // prefix is the only thing telling the two apart on the Core.
    clientId: mintPanelCoreClientId(),
    reconnectInitialMs: RECONNECT_INITIAL_MS,
    reconnectMaxMs: RECONNECT_MAX_MS,
    // The cursor store is `localStorage`-shaped because a browser store is the
    // shape the SDK is injected with rather than reaching for (issue 153). Here
    // it is the Core registry: one cursor per Core, keyed by coreId, so the key
    // the client passes is irrelevant. This is the whole of the cursor path —
    // the client persists through it as each event lands and reads it back when
    // it subscribes.
    storage: {
      getItem: () => String(cursor.read()),
      setItem: (_key, value) => cursor.write(Number(value)),
    },
  });
  void client.connect().catch(() => {
    /* reported on onAuthError / onDisconnected; the client dials again itself */
  });
  return asPanelLink(client);
}

/**
 * Mint this link's Core client id (ADR 0024 D9).
 *
 * Random rather than derived: two links must not collide, and every input that
 * would make one stable across processes — the endpoint, the coreId, the bearer
 * — is shared by every client dialing that machine, which is the one shape D9
 * forbids. Unguessability buys nothing security-wise and is not claimed to.
 *
 * The `panel-` prefix is the point: on the Core, a reclaim is otherwise an
 * opaque token with no clue which of a machine's clients reconnected.
 *
 * @internal — exported for the test that pins the prefix and the randomness.
 */
export function mintPanelCoreClientId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `panel-${random}`;
  // Node 24 has `crypto.randomUUID`. The fallback keeps an id — which only has
  // to differ from its neighbours — from being the thing that throws.
  return `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The SDK's client as this manager's port (#156).
 *
 * Thin on purpose, and one method wide: a durable Core client already answers
 * every call on {@link CoreLinkClientLike} except `onProtocolVersion`, which is
 * `onReady` under the name this Panel's dial states are written in. Renaming
 * the port instead would have rippled into the router and into every fake in
 * the suite — the migration would then be visible in tests, which is exactly
 * what it must not be.
 */
function asPanelLink(client: DurableCoreClient): CoreLinkClientLike {
  return {
    onAuthOk: (cb) => client.onAuthOk(cb),
    onAuthError: (cb) => client.onAuthError(cb),
    onDisconnected: (cb) => client.onDisconnected(cb),
    // Every connection's `ready`, which is what this manager reads drift and
    // the `files` capability off. The SDK carries the same three fields on a
    // wider answer.
    onProtocolVersion: (cb) =>
      client.onReady(({ protocolVersion, compatible, files }) =>
        cb({ version: protocolVersion, compatible, files }),
      ),
    request: (frame, timeoutMs) => client.request(frame, timeoutMs),
    onData: (cb) => client.onData(cb),
    onExit: (cb) => client.onExit(cb),
    onEvent: (cb) => client.onEvent(cb),
    ptySubscribe: (ptyId, opts) => client.ptySubscribe(ptyId, opts),
    ptyUnsubscribe: (ptyId) => client.ptyUnsubscribe(ptyId),
    canSendMultiConnectionFrames: () => client.canSendMultiConnectionFrames(),
    onReclaimed: (cb) => client.onReclaimed(cb),
    close: () => client.close(),
  };
}

let singleton: CoreLinkManager | null = null;

/** The process-wide manager. The Panel service has exactly one set of core-links. */
export function coreLinkManager(): CoreLinkManager {
  if (!singleton) singleton = new CoreLinkManager();
  return singleton;
}

/** @internal — tests that need a fresh process-wide manager. */
export function resetCoreLinkManagerForTests(): void {
  singleton?.dispose();
  singleton = null;
}
