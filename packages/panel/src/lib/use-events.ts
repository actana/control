import { useEffect } from "react";

export type ServerEvent = { type: string; [k: string]: unknown };

// Backoff before reconnecting the SSE stream after a transient error.
const SSE_RECONNECT_DELAY_MS = 1500;

// A SINGLE shared EventSource fans every server event out to all in-renderer
// listeners. Each useServerEvents() call used to open its own EventSource (and
// fetch its own single-use ticket), so a route with several subscribers held
// several duplicate SSE connections and delivered every event once per
// subscriber, each doing overlapping query invalidations. Now there is one
// socket, one ticket, and N cheap in-process listeners.
type Listener = (e: ServerEvent) => void;

const listeners = new Set<Listener>();
/**
 * Told when the stream comes back up after it went down — see
 * {@link useServerEventsReconnect}. A separate set from `listeners` on purpose:
 * these subscribers reconcile state, they are not a reason to hold a socket
 * open, so they never start a connection and never keep one alive.
 */
const reconnectListeners = new Set<() => void>();
let source: EventSource | null = null;
let connecting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Has the stream been down since the last time it was up?
 *
 * The server keeps no event log and sends no `id:` lines, so there is no
 * cursor to resume from and nothing to replay: whatever it emitted while this
 * tab was disconnected is gone for good. What the tab CAN know is that a gap
 * happened, and that is what this flag carries to the reconnect subscribers,
 * who re-read rather than trust what is on screen. Set on error, cleared on
 * the open that follows — so a first connection is not mistaken for a gap.
 */
let streamWasLost = false;

function scheduleReconnect(): void {
  if (reconnectTimer !== null || listeners.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, SSE_RECONNECT_DELAY_MS);
}

function announceReconnect(): void {
  if (!streamWasLost) return;
  streamWasLost = false;
  // Snapshot: a subscriber that unsubscribes while being told must not mutate
  // the set mid-iteration, and one that throws must not silence the rest.
  for (const listener of [...reconnectListeners]) {
    try {
      listener();
    } catch {
      /* swallow */
    }
  }
}

async function connect(): Promise<void> {
  if (typeof window === "undefined") return;
  // Guards are synchronous up to `connecting = true`, so concurrent callers in
  // the same tick can't open two sockets.
  if (source || connecting || listeners.size === 0) return;
  connecting = true;

  // EventSource can't set headers, but it does send same-origin cookies — so
  // the Operator's session authenticates the stream with no handshake.
  const es = new EventSource("/api/events");
  source = es;
  connecting = false;
  es.onopen = () => {
    announceReconnect();
  };
  es.onmessage = (msg) => {
    let data: ServerEvent;
    try {
      data = JSON.parse(msg.data);
    } catch {
      return;
    }
    // A message is proof the stream is up. Some EventSource implementations
    // (and every stub a test writes) deliver the server's opening frame
    // without firing `onopen`, and a gap that is never announced is a gap
    // nothing reconciles.
    announceReconnect();
    // Snapshot so a listener that (un)subscribes during dispatch can't mutate
    // the set mid-iteration; isolate a throwing listener from the rest.
    for (const listener of [...listeners]) {
      try {
        listener(data);
      } catch {
        /* swallow */
      }
    }
  };
  es.onerror = () => {
    es.close();
    if (source === es) source = null;
    // Everything the server emits from here until the next open is lost.
    streamWasLost = true;
    scheduleReconnect();
  };
}

function closeIfIdle(): void {
  if (listeners.size > 0) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  source?.close();
  source = null;
}

export function useServerEvents(onEvent: (e: ServerEvent) => void) {
  useEffect(() => {
    listeners.add(onEvent);
    void connect();
    return () => {
      listeners.delete(onEvent);
      closeIfIdle();
    };
  }, [onEvent]);
}

/**
 * Called once each time the shared stream comes back after dropping.
 *
 * A dropped SSE connection is a hole in this tab's knowledge, not a pause: a
 * Session that finishes while the socket is down emits its `task:updated` into
 * a stream nobody is reading, and no replay brings it back (issue 484). The
 * subscriber's job is therefore to re-read whatever the stream feeds, exactly
 * as `useCoreLiveQueries` already does for the core-link's own reconnects.
 *
 * Subscribing does not open or hold the stream — only {@link useServerEvents}
 * does that — so a tab with nothing listening for events is told nothing.
 */
export function useServerEventsReconnect(onReconnect: () => void) {
  useEffect(() => {
    reconnectListeners.add(onReconnect);
    return () => {
      reconnectListeners.delete(onReconnect);
    };
  }, [onReconnect]);
}

/** Test-only: drop every subscriber and forget the connection's history. */
export function __resetServerEventsForTests(): void {
  listeners.clear();
  reconnectListeners.clear();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  source?.close();
  source = null;
  connecting = false;
  streamWasLost = false;
}
