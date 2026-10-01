// The Shared folder's sync: `~/shared` and the Core's S3 prefix, kept the same (#562,
// ADR 0041 D33).
//
// **Who runs it.** The daemon, as `actana` in the container. It alone holds the key (the
// key store, `shared-key-store.ts`); `core` never sees one. What it reads or writes in
// `core`'s home goes through `SharedHome` (`shared-home-io.ts`), which is the Files helper
// started through `asCore`. S3 is the SDK's S3 mode (`@actana/sdk/shared`): no AWS SDK,
// no rclone, no FUSE, no capability the daemon does not already hold.
//
// **How it decides.** A pass lists both sides and compares each path with what the last
// pass left behind (its `base`: the size and mtime of each side as last made equal).
//
//   changed here only        -> upload          changed there only      -> download
//   changed on both          -> the newer mtime wins
//   gone here, unchanged there   -> deleted here: delete there
//   gone there, unchanged here   -> deleted there: delete here
//   gone here, changed there     -> the change wins, so it comes back
//
// Nothing is guessed about a path with no base (the first pass): it is "changed" on every
// side it exists on, so a file present on one side is copied and never deleted.
//
// **The key.** One an hour is pushed (`sharedCredentials`) and replaces the stored one. A
// request signs with whatever key is current when it is made, so a push in the middle of a
// big upload leaves that upload alone and the next request uses the new key. When the key
// has expired nothing is sent to S3 at all (the sync is read-only: whatever `core` writes
// stays in the folder), and the next push starts it again.
//
// **Unpair** (`sharedDetach`) is one pass that only copies, S3 into the folder, and then
// the sync stops. It never deletes anything, and it never overwrites a file `core` has
// changed since the last pass.
//
// The change feed is not here. What the sync writes into `~/shared` is seen by the watcher
// of #561, which runs as `core`, and becomes `shared:changed` like any other write.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CoreLinkRequestFrame, CoreLinkSharedMountStatus } from "@actana/sdk/core";
import { CoreSharedError, createS3CoreShared, type CoreShared } from "@actana/sdk/shared";
import log from "@actana/shared/log";
import { createSharedKeyStore, normalizePrefix, type SharedAttachment, type SharedKeyStore } from "./shared-key-store";
import type { SharedHome } from "./shared-home-io";

/** Between passes. A push, an attach and a detach run one at once. */
export const SYNC_INTERVAL_MS = 15_000;
/** A file this big is left alone: the SDK's S3 mode moves a whole file through memory. */
export const MAX_SYNC_FILE_BYTES = 128 * 1024 * 1024;

export const SYNC_STATE_FILE = "shared-sync.json";

type Side = { size: number; mtime: number };
type Base = { lSize: number; lMtime: number; rSize: number; rMtime: number };
type SyncState = { version: 1; base: Record<string, Base>; pending: string[] };

export type PassReport = {
  /** Why nothing was done, when nothing was. */
  skipped?: "detached" | "expired" | "no-folder";
  uploaded: string[];
  downloaded: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  failed: Array<{ path: string; why: string }>;
};

export type SharedSyncOptions = {
  /** The daemon's state directory: the key and the sync's own state live here. */
  stateDir: string;
  home: SharedHome;
  keyStore?: SharedKeyStore;
  /** Epoch ms. Tests pass a fake clock. */
  now?: () => number;
  intervalMs?: number;
  maxFileBytes?: number;
  /** Test seam: the S3 client for an attachment, given the provider of the current key. */
  createShared?: (attachment: SharedAttachment, credentials: KeyProvider) => CoreShared;
  fetch?: typeof fetch;
};

type KeyProvider = { get(): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: Date }> };

export type SharedSync = {
  /** True once a controller has attached this Core, until it detaches. */
  readonly attached: boolean;
  /** Handle one of the three Shared-folder frames the controller sends. */
  handle(frame: CoreLinkRequestFrame): Promise<CoreLinkSharedMountStatus>;
  /** One pass, now. Passes never overlap: one asked for during another runs after it. */
  pass(): Promise<PassReport>;
  /** Resolves when no pass is running and none is waiting. */
  idle(): Promise<void>;
  /** Start the periodic passes, when attached. */
  start(): void;
  stop(): void;
};

const emptyReport = (): PassReport => ({ uploaded: [], downloaded: [], deletedLocal: [], deletedRemote: [], failed: [] });

export function createSharedSync(options: SharedSyncOptions): SharedSync {
  const store = options.keyStore ?? createSharedKeyStore(options.stateDir);
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? SYNC_INTERVAL_MS;
  const maxBytes = options.maxFileBytes ?? MAX_SYNC_FILE_BYTES;
  const statePath = path.join(options.stateDir, SYNC_STATE_FILE);
  const home = options.home;

  let current: SharedAttachment | null = store.load();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let running: Promise<PassReport> | null = null;
  let again = false;
  let readOnlyLogged = false;
  const tooBig = new Set<string>();

  // The provider reads `current` on every request, so a key pushed while a request is
  // being made is used by the next one and does not touch the one in flight.
  const provider: KeyProvider = {
    async get() {
      const key = current;
      if (!key) throw new CoreSharedError("expired", "the Core is not attached");
      if (now() >= key.expiresAt) throw new CoreSharedError("expired", "the key has expired");
      return {
        accessKeyId: key.accessKeyId,
        secretAccessKey: key.secretAccessKey,
        sessionToken: key.sessionToken,
        expiresAt: new Date(key.expiresAt),
      };
    },
  };

  const clientFor = (attachment: SharedAttachment): CoreShared =>
    options.createShared
      ? options.createShared(attachment, provider)
      : createS3CoreShared({
          endpoint: attachment.endpoint,
          bucket: attachment.bucket,
          prefix: attachment.prefix,
          region: attachment.region,
          credentials: provider,
          now,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });

  function loadState(): SyncState {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<SyncState>;
      if (raw.version === 1 && raw.base && typeof raw.base === "object" && Array.isArray(raw.pending)) {
        return { version: 1, base: raw.base, pending: raw.pending.filter((p): p is string => typeof p === "string") };
      }
    } catch {
      // No state, or damaged: the next pass treats everything as new, which copies and never deletes.
    }
    return { version: 1, base: {}, pending: [] };
  }

  function saveState(state: SyncState): void {
    fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    const temp = `${statePath}.${crypto.randomBytes(6).toString("hex")}`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, statePath);
  }

  /** One pass. `mode` "pull" is unpair: copy S3 into the folder, delete nothing, overwrite nothing `core` changed. */
  async function runPass(mode: "sync" | "pull"): Promise<PassReport> {
    const report = emptyReport();
    const attachment = current;
    if (!attachment) return { ...report, skipped: "detached" };
    if (now() >= attachment.expiresAt) {
      if (!readOnlyLogged) {
        readOnlyLogged = true;
        log.warn("shared-sync.key-expired", { expiredAt: new Date(attachment.expiresAt).toISOString() });
      }
      return { ...report, skipped: "expired" };
    }
    readOnlyLogged = false;

    const shared = clientFor(attachment);
    const state = loadState();
    const localFiles = await home.list();
    if (localFiles === null) return { ...report, skipped: "no-folder" };
    const local = new Map<string, Side>(localFiles.map((f) => [f.path, { size: f.size, mtime: f.mtime }]));

    const remote = await listRemote(shared);
    const paths = [...new Set([...local.keys(), ...remote.keys(), ...Object.keys(state.base)])].sort();

    const uploaded = new Map<string, number>();

    for (const p of paths) {
      const l = local.get(p);
      const r = remote.get(p);
      const b = state.base[p];
      const oversize = (l && l.size > maxBytes) || (r && r.size > maxBytes);
      if (oversize) {
        if (!tooBig.has(p)) {
          tooBig.add(p);
          log.warn("shared-sync.file-too-big", { path: p, limit: maxBytes });
        }
        continue;
      }
      try {
        const lChanged = !!l && (!b || l.size !== b.lSize || l.mtime !== b.lMtime);
        const rChanged = !!r && (!b || r.size !== b.rSize || r.mtime !== b.rMtime);

        if (state.pending.includes(p)) {
          // A download of this path was cut short: what is on disk may be half a file, so it
          // must not be uploaded. The remote copy decides.
          if (r) await download(p, r);
          else state.pending = state.pending.filter((x) => x !== p);
          continue;
        }

        if (l && r) {
          if (!lChanged && !rChanged) {
            if (!b) state.base[p] = { lSize: l.size, lMtime: l.mtime, rSize: r.size, rMtime: r.mtime };
          } else if (lChanged && !rChanged) {
            if (mode === "sync") await upload(p, l);
          } else if (!lChanged && rChanged) {
            await download(p, r);
          } else if (mode === "sync" && l.mtime > r.mtime) {
            log.info("shared-sync.conflict", { path: p, kept: "local" });
            await upload(p, l);
          } else if (mode === "sync") {
            log.info("shared-sync.conflict", { path: p, kept: "remote" });
            await download(p, r);
          }
          // In "pull" a file `core` changed and S3 changed too is left as `core` has it.
        } else if (l && !r) {
          if (b && !lChanged) {
            if (mode === "sync") {
              await home.remove(p);
              delete state.base[p];
              report.deletedLocal.push(p);
            }
          } else if (mode === "sync") {
            await upload(p, l);
          }
        } else if (!l && r) {
          if (b && !rChanged && mode === "sync") {
            await shared.rm(p);
            delete state.base[p];
            report.deletedRemote.push(p);
          } else {
            await download(p, r);
          }
        } else {
          delete state.base[p];
        }
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        report.failed.push({ path: p, why });
        log.warn("shared-sync.path-failed", { path: p, error: why });
        // A key that stopped working ends the pass; the next push starts it again.
        if (err instanceof CoreSharedError && (err.code === "expired" || err.code === "forbidden")) break;
      }
    }

    // What S3 now says about what was uploaded, so the next pass does not take its own
    // upload for a change made over there.
    if (uploaded.size > 0) {
      try {
        const after = await listRemote(shared);
        for (const [p, size] of uploaded) {
          const r = after.get(p);
          const b = state.base[p];
          if (b) {
            b.rSize = r?.size ?? size;
            b.rMtime = r && r.size === size ? r.mtime : -1;
          }
        }
      } catch (err) {
        log.warn("shared-sync.relist-failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    saveState(state);
    return report;

    async function upload(p: string, l: Side): Promise<void> {
      const data = await home.read(p);
      await shared.put(p, data);
      state.base[p] = { lSize: data.length, lMtime: l.mtime, rSize: data.length, rMtime: -1 };
      uploaded.set(p, data.length);
      report.uploaded.push(p);
    }

    async function download(p: string, r: Side): Promise<void> {
      const file = await shared.get(p);
      if (!state.pending.includes(p)) {
        state.pending.push(p);
        saveState(state);
      }
      const written = await home.write(p, Buffer.from(file.body), r.mtime);
      state.pending = state.pending.filter((x) => x !== p);
      state.base[p] = { lSize: written.size, lMtime: written.mtime, rSize: r.size, rMtime: r.mtime };
      report.downloaded.push(p);
    }
  }

  async function listRemote(shared: CoreShared): Promise<Map<string, Side>> {
    const { changes } = await shared.watch();
    const remote = new Map<string, Side>();
    for (const change of changes) {
      if (change.kind !== "file" || change.deleted) continue;
      remote.set(change.path, { size: change.size ?? 0, mtime: change.modifiedAt?.getTime() ?? 0 });
    }
    return remote;
  }

  /** One pass at a time; one asked for while another runs follows it. */
  function pass(mode: "sync" | "pull" = "sync"): Promise<PassReport> {
    if (running) {
      again = true;
      return running;
    }
    const run = runPass(mode)
      .catch((err: unknown) => {
        log.warn("shared-sync.pass-failed", { error: err instanceof Error ? err.message : String(err) });
        return { ...emptyReport(), failed: [{ path: "", why: err instanceof Error ? err.message : String(err) }] };
      })
      .finally(() => {
        running = null;
        if (again && !stopped) {
          again = false;
          void pass();
        }
      });
    running = run;
    return run;
  }

  function schedule(): void {
    if (stopped || timer || !current) return;
    timer = setTimeout(() => {
      timer = null;
      void pass().finally(schedule);
    }, intervalMs);
    timer.unref?.();
  }

  const iso = (ms: number): string => new Date(ms).toISOString();
  const refused = (code: "invalid-frame" | "not-attached" | "already-attached" | "mount-failed", message: string): CoreLinkSharedMountStatus => ({
    state: "error",
    code,
    message,
  });

  async function handle(frame: CoreLinkRequestFrame): Promise<CoreLinkSharedMountStatus> {
    switch (frame.type) {
      case "sharedAttach": {
        if (current) return refused("already-attached", "this Core is already attached; push credentials instead");
        const expiresAt = Date.parse(frame.expiresAt);
        const prefix = normalizePrefix(frame.prefix);
        if (!prefix) return refused("invalid-frame", "prefix must be a relative path inside the bucket");
        if (!Number.isFinite(expiresAt) || expiresAt <= now()) return refused("invalid-frame", "expiresAt is not in the future");
        const attachment: SharedAttachment = {
          endpoint: frame.endpoint,
          bucket: frame.bucket,
          prefix,
          region: frame.region,
          accessKeyId: frame.credentials.accessKeyId,
          secretAccessKey: frame.credentials.secretAccessKey,
          sessionToken: frame.credentials.sessionToken,
          expiresAt,
        };
        // The key must work before it is kept: a bad one is reported to the controller now.
        const saved = current;
        current = attachment;
        try {
          await clientFor(attachment).list("");
        } catch (err) {
          current = saved;
          const code = err instanceof CoreSharedError ? err.code : "unavailable";
          return refused("mount-failed", `the store did not accept the key (${code})`);
        }
        try {
          store.save(attachment);
        } catch (err) {
          current = saved;
          log.error("shared-sync.key-not-saved", { error: err instanceof Error ? err.message : String(err) });
          return refused("mount-failed", "the Core could not store the key");
        }
        stopped = false;
        schedule();
        void pass();
        return { state: "attached", expiresAt: iso(expiresAt) };
      }
      case "sharedCredentials": {
        if (!current) return refused("not-attached", "this Core is not attached");
        const expiresAt = Date.parse(frame.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= now()) return refused("invalid-frame", "expiresAt is not in the future");
        const next: SharedAttachment = {
          ...current,
          accessKeyId: frame.credentials.accessKeyId,
          secretAccessKey: frame.credentials.secretAccessKey,
          sessionToken: frame.credentials.sessionToken,
          expiresAt,
        };
        try {
          store.save(next);
        } catch (err) {
          log.error("shared-sync.key-not-saved", { error: err instanceof Error ? err.message : String(err) });
          return refused("mount-failed", "the Core could not store the key");
        }
        current = next;
        readOnlyLogged = false;
        schedule();
        void pass();
        return { state: "attached", expiresAt: iso(expiresAt) };
      }
      case "sharedDetach": {
        if (!current) return refused("not-attached", "this Core is not attached");
        // Wait for a pass in flight, then copy what is in S3 into the folder.
        while (running) await running;
        const report = await pass("pull");
        if (report.skipped === "expired") {
          return refused("mount-failed", "the key has expired, so S3 cannot be copied: push credentials, then detach");
        }
        if (report.skipped || report.failed.length > 0) {
          return refused("mount-failed", "S3 could not be copied into the folder; nothing was detached");
        }
        stop();
        store.clear();
        fs.rmSync(statePath, { force: true });
        current = null;
        return { state: "detached", keptLocalCopy: true };
      }
      default:
        return refused("invalid-frame", "not a Shared-folder frame");
    }
  }

  function stop(): void {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    get attached() {
      return current !== null;
    },
    handle,
    pass: () => pass(),
    async idle() {
      while (running) await running;
    },
    start() {
      stopped = false;
      if (current) {
        schedule();
        void pass();
      }
    },
    stop,
  };
}
