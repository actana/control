import { createS3CoreShared, type CoreShared } from "@actana/sdk/shared";
import type { SharedKey, SharedKeyIssuer } from "@actana/sdk/shared-key";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { findSharedFolder } from "../repositories/core-shared-folders.repo";
import { getCore } from "./cores";
import { getStorageConfig, storageKeyIssuer, type StorageTarget } from "./storage";

/**
 * The SDK's CoreShared **S3 mode for one Core**, built from the server-held key (ADR 0041 D5, D33). One place builds
 * it, for the Files tab (#565) and the Task result watcher (#570): the Core's folder is read in the object store
 * directly, with a 1-hour key the Panel's issuer gave for that one Core (limited to `<prefix>/<core id>/`), so it
 * works while the Core is offline or paused, and one Core's client can never name another Core's folder.
 *
 * - **The owner.** The Core and its folder row are read by owner on every call, so another owner's Core is "no such
 *   Core", and a Core that was unpaired gets nothing from a client built earlier.
 * - **Keys.** The master key is read only by `storageKeyIssuer`. The key of a Core is kept here, in memory, until six
 *   minutes before it ends (a 5-minute download URL needs that much), and is never returned or logged.
 */

/** This Core has no Shared folder to read: not paired from a Panel with storage, or not finished. */
export class SharedFilesUnavailableError extends ConflictError {
  readonly code = "no-shared-folder";
  constructor(message: string) {
    super(message);
    this.name = "SharedFilesUnavailableError";
  }
}

const KEY_MIN_LEFT_MS = 6 * 60_000;
const BACKEND_LABEL: Record<string, string> = { seaweedfs: "SeaweedFS" };

export type CoreS3Deps = {
  issuer: (ownerId: number) => Promise<{ issuer: SharedKeyIssuer; target: StorageTarget }>;
  s3: (opts: { target: StorageTarget; folder: string; key: SharedKey; fetch?: typeof fetch }) => CoreShared;
  now: () => number;
  fetch?: typeof fetch;
};

function defaultDeps(): CoreS3Deps {
  return {
    issuer: (ownerId) => storageKeyIssuer(ownerId),
    s3: ({ target, folder, key, fetch }) =>
      createS3CoreShared({
        endpoint: target.endpoint,
        bucket: target.bucket,
        prefix: folder.replace(/\/+$/, ""),
        region: target.region,
        credentials: { get: async () => key },
        ...(fetch ? { fetch } : {}),
      }),
    now: Date.now,
  };
}

export type HeldCoreShared = { shared: CoreShared; folder: string; expiresAt: number; backend: string };

export class CoreS3Shared {
  private readonly deps: CoreS3Deps;
  private readonly held = new Map<string, HeldCoreShared>();

  constructor(deps: Partial<CoreS3Deps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /**
   * The S3 client for this owner's Core, from a live key (a new one when the held key is about to end). Throws when the
   * owner has no such Core, when it has no Shared folder yet, or when storage is not configured.
   */
  async open(ownerId: number, coreId: string): Promise<HeldCoreShared> {
    // Who may ask is decided on every call, from the database: a cached key is never a licence.
    if (!(await getCore(coreId, ownerId))) throw new NotFoundError("no such Core");
    const row = await findSharedFolder(ownerId, coreId);
    if (!row || row.state === "pending" || !row.s3Prefix) {
      throw new SharedFilesUnavailableError("This Core has no Shared folder yet: finish its pairing with storage first.");
    }
    const folder = row.s3Prefix;
    // The folder must be this Core's own, whatever the row says (the same rule the delete applies).
    if (!folder.endsWith(`/${coreId}/`)) throw new ValidationError("The stored folder is not this Core's folder.");

    const cacheKey = `${ownerId}:${coreId}`;
    const cached = this.held.get(cacheKey);
    if (cached && cached.folder === folder && cached.expiresAt - this.deps.now() > KEY_MIN_LEFT_MS) return cached;

    const { issuer, target } = await this.deps.issuer(ownerId);
    const key = await issuer.issue(coreId);
    const held: HeldCoreShared = {
      shared: this.deps.s3({ target, folder, key, fetch: this.deps.fetch }),
      folder,
      expiresAt: key.expiresAt.getTime(),
      backend: BACKEND_LABEL[(await getStorageConfig(ownerId)).backend ?? ""] ?? "S3",
    };
    this.held.set(cacheKey, held);
    return held;
  }
}

let singleton: CoreS3Shared | null = null;

/** The one the Panel runs: the Files tab and the Task watcher share its keys. */
export function coreS3Shared(): CoreS3Shared {
  if (!singleton) singleton = new CoreS3Shared();
  return singleton;
}

/** @internal */
export function resetCoreS3SharedForTests(next: CoreS3Shared | null = null): void {
  singleton = next;
}
