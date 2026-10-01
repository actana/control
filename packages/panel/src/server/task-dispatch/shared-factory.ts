import { httpsBaseUrlFor } from "@actana/sdk/pairing";
import { createCoreFilesFetch } from "@actana/sdk/core";
import {
  createThroughCoreShared,
  type CoreShared,
  type SharedChangedEvent,
  type SharedChangedEventSource,
} from "@actana/sdk/shared";
import { getCore, getCoreSecrets } from "../services/cores";
import { coreLinkManager, type CoreLinkManager } from "../services/core-link-manager";
import { filesFetchFor } from "../services/core-files-proxy";

/**
 * Which `CoreShared` the result watcher reads a Core's Shared folder through
 * (#570), chosen in ONE place.
 *
 * - **S3 mode**, when the Panel has storage configured: the object store is read
 *   directly, so a result is seen while the Core is paused. It needs the Panel's
 *   storage settings and the key issuer, which wait on #562 and #566; neither
 *   exists in the Panel yet, so nothing passes `s3` today and this seam is all
 *   that is built.
 * - **Through-the-Core mode** otherwise: the Core's Files API and its
 *   `shared:changed` events. It works only while the Core is up.
 *
 * The watcher is written on the `CoreShared` interface and cannot tell which it has.
 */

export type SharedFactoryDeps = {
  /** The S3 mode for one Core. Set only when the Panel has storage configured. */
  s3?: ((coreId: string) => Promise<CoreShared> | CoreShared) | null;
  throughCore: (coreId: string) => Promise<CoreShared> | CoreShared;
};

export type SharedFor = (coreId: string) => Promise<CoreShared>;

export function createSharedFactory(deps: SharedFactoryDeps): SharedFor {
  return async (coreId) => (deps.s3 ? deps.s3(coreId) : deps.throughCore(coreId));
}

const MAX_BUFFERED_EVENTS = 10_000;

/**
 * The `shared:changed` events each Core's link has delivered, kept in memory so
 * the through-the-Core `watch` can replay "since an event id". The Panel's links
 * already receive every event and replay what was missed while one was down, so
 * this reads off them and asks the Core for nothing more.
 */
export class SharedChangeFeed {
  private readonly buffers = new Map<string, SharedChangedEvent[]>();
  private readonly unsubscribes = new Map<string, () => void>();

  /** Listen on every link the manager has now or later. Returns a function that stops listening. */
  attach(manager: Pick<CoreLinkManager, "onClient"> = coreLinkManager()): () => void {
    const off = manager.onClient((coreId, client) => {
      this.unsubscribes.get(coreId)?.();
      this.unsubscribes.set(
        coreId,
        client.onEvent(({ event }) => {
          if (event.kind === "shared:changed") this.push(coreId, event.eventId, event.payload);
        }),
      );
    });
    return () => {
      off();
      for (const unsubscribe of this.unsubscribes.values()) unsubscribe();
      this.unsubscribes.clear();
    };
  }

  push(coreId: string, eventId: number, payload: string): void {
    let parsed: { path?: unknown; size?: unknown; mtime?: unknown; deleted?: unknown };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed.path !== "string" || typeof parsed.deleted !== "boolean") return;
    const size = typeof parsed.size === "number" ? parsed.size : 0;
    const mtime = typeof parsed.mtime === "number" ? parsed.mtime : 0;
    const buffer = this.buffers.get(coreId) ?? [];
    if (buffer.length > 0 && buffer[buffer.length - 1]!.eventId >= eventId) return;
    buffer.push({ eventId, path: parsed.path, size, mtime, deleted: parsed.deleted });
    if (buffer.length > MAX_BUFFERED_EVENTS) buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS);
    this.buffers.set(coreId, buffer);
  }

  source(coreId: string): SharedChangedEventSource {
    return {
      tip: () => this.buffers.get(coreId)?.at(-1)?.eventId ?? 0,
      since: (since) => (this.buffers.get(coreId) ?? []).filter((e) => e.eventId > since),
    };
  }
}

/** The through-the-Core mode for a registered Core: its Files API over mTLS, with the link's bearer. */
export function createThroughCoreFactory(
  feed: SharedChangeFeed,
  ownerId: number,
): (coreId: string) => Promise<CoreShared> {
  return async (coreId) => {
    const core = await getCore(coreId, ownerId);
    const secrets = core ? await getCoreSecrets(coreId, ownerId) : null;
    if (!core || !secrets?.bearer) {
      throw new Error("this Core is not registered with this Panel, or its stored credentials could not be read");
    }
    return createThroughCoreShared({
      baseUrl: httpsBaseUrlFor(core.endpoint),
      bearer: secrets.bearer,
      fetch: filesFetchFor(coreId, secrets, createCoreFilesFetch),
      events: feed.source(coreId),
    });
  };
}

/**
 * A `CoreShared` that is looked up on each use instead of once. For a Task taken over after a restart whose Core
 * is not reachable (or no longer registered) yet: it is still watched, every read fails and says why, and the
 * timeout ends the Task, instead of the Task having nothing watching it.
 */
export function lazyShared(resolve: () => Promise<CoreShared>): CoreShared {
  return {
    list: async (path) => (await resolve()).list(path),
    get: async (path) => (await resolve()).get(path),
    put: async (path, body) => (await resolve()).put(path, body),
    mkdir: async (path) => (await resolve()).mkdir(path),
    rm: async (path) => (await resolve()).rm(path),
    move: async (from, to) => (await resolve()).move(from, to),
    upload: async (destination, entries) => (await resolve()).upload(destination, entries),
    watch: async (since) => (await resolve()).watch(since),
    signedUrl: async (path, options) => (await resolve()).signedUrl(path, options),
  };
}
