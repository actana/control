import { randomBytes } from "node:crypto";
import type {
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
  CoreLinkSharedMountStatus,
} from "@actana/shared/sdk-link-frames";
import { createS3CoreShared } from "@actana/sdk/shared";
import type { CoreShared } from "@actana/sdk/shared";
import { refreshAtMs, type SharedKey, type SharedKeyIssuer } from "@actana/sdk/shared-key";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import {
  findAllSharedFolders,
  findLiveSharedFolders,
  findSharedFolder,
  updateLiveSharedFolder,
  updateSharedFolder,
  type CoreSharedFolderRow,
} from "../repositories/core-shared-folders.repo";
import { coreLinkManager, type CoreLinkClientLike } from "./core-link-manager";
import { getCore, getCoreSecrets, listCores, removeCore } from "./cores";
import { emptyMachineFolder, type MachineFolderResult } from "./core-machine-folder";
import { createCoreFilesFetch } from "@actana/sdk/core";
import { httpsBaseUrlFor } from "@actana/sdk/pairing";
import { filesFetchFor } from "./core-files-proxy";
import { OPERATOR_ID } from "./operator";
import type { CoreSharedFolder } from "~/shared/cores";
import type { SharedConnectionResult, StorageCoreFolderView } from "~/shared/storage-wire";
import { coreFolderPrefix, storageKeyIssuer, type StorageTarget } from "./storage";

/**
 * A Core's Shared folder, from the Panel's side (#564, ADR 0041 D5, D33; the Core's side is
 * `docs/shared-folder.md`). The Panel holds the master key, asks the SDK's issuer for a **1-hour key limited
 * to `<prefix>/<core id>/`**, and pushes it over the core-link: `sharedAttach` once, then `sharedCredentials`
 * before each key ends. The issuer returns four fields and never the key it signs with, so nothing here
 * can send the master key to a Core: it has no way to get it.
 *
 * A key is replaced `refreshAtMs` before it ends: 15 minutes, never more than half its life, as the SDK's
 * own provider does it. A push that fails is retried with a back-off and **shown on the Core** (`lastError`
 * on its folder row, and an error log): it is never swallowed.
 */

/** The slice of the link this service drives; the manager's client satisfies it and a test's fake does too. */
export type SharedLink = Pick<CoreLinkClientLike, "request" | "sharedCapability">;

export type Timer = ReturnType<typeof setTimeout>;

export type SharedFolderDeps = {
  link: (coreId: string) => SharedLink | null;
  /** Is this Core's link authenticated right now? At boot a refresh waits for it instead of failing. */
  isConnected: (coreId: string) => boolean;
  issuer: (ownerId: number) => Promise<{ issuer: SharedKeyIssuer; target: StorageTarget }>;
  s3: (opts: { target: StorageTarget; folder: string; key: SharedKey; fetch?: typeof fetch }) => CoreShared;
  /** Empty `~/shared` on the Core's machine through its Files API. Only called while the Core's link is up. */
  emptyMachineFolder: (coreId: string, ownerId: number) => Promise<MachineFolderResult>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (t: Timer) => void;
  /** Retry delays after a failed push, in ms; the last repeats. */
  retryDelaysMs: readonly number[];
  requestTimeoutMs: number;
  log: (message: string) => void;
  fetch?: typeof fetch;
};

/** A refusal the operator reads: what the Core said, or why the Panel would not ask. Never a key. */
export class SharedFolderError extends ConflictError {
  constructor(
    message: string,
    readonly code:
      | "not-connected"
      | "cannot-mount"
      | "no-folder"
      | "isolation-failed"
      | "core-refused"
      | "confirmation"
      | "still-attached"
      | "prefix-delete-failed",
  ) {
    super(message);
    this.name = "SharedFolderError";
  }
}

export type { SharedConnectionResult } from "~/shared/storage-wire";

/** What a delete did. `machineFolder.state` is `kept` when the Core was not reachable (or `~/shared` could not be emptied). */
export type DeleteCoreResult = { prefix: string | null; removed: number; machineFolder: MachineFolderResult };

const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] as const;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DELETE_PASSES = 100;

function defaultDeps(): SharedFolderDeps {
  return {
    link: (coreId) => coreLinkManager().client(coreId),
    isConnected: (coreId) => coreLinkManager().status(coreId).state === "connected",
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
    emptyMachineFolder: async (coreId, ownerId) => {
      const core = await getCore(coreId, ownerId);
      const secrets = core ? await getCoreSecrets(coreId, ownerId) : null;
      if (!core || !secrets?.bearer) {
        return { state: "kept", reason: "the Core's stored credentials could not be read", removed: 0 };
      }
      return emptyMachineFolder({
        baseUrl: httpsBaseUrlFor(core.endpoint),
        bearer: secrets.bearer,
        fetch: filesFetchFor(coreId, secrets, createCoreFilesFetch),
      });
    },
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
    retryDelaysMs: RETRY_DELAYS_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    log: (message) => console.error(message),
  };
}

function statusOf(frame: CoreLinkResponseFrame): CoreLinkSharedMountStatus {
  if (frame.type === "sharedStatus") return frame.status;
  // Anything else (a bare `error`, say) is a Core that did not answer the way the contract says.
  return { state: "error", code: "mount-failed", message: "the Core did not answer with a sharedStatus" };
}

function describe(status: CoreLinkSharedMountStatus): string {
  return status.state === "error" ? `${status.code}: ${status.message}` : status.state;
}

export class SharedFolders {
  private readonly deps: SharedFolderDeps;
  private readonly timers = new Map<string, Timer>();
  private readonly attempts = new Map<string, number>();
  private readonly generation = new Map<string, number>();

  constructor(deps: Partial<SharedFolderDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  // ─── The connection test ─────────────────────────────────────────────────

  /**
   * Issue a key for this Core and prove it works on its own folder and nowhere else: write, read and list
   * there, and **fail** to list, read or write the folder of a Core that does not exist. Writes one probe
   * object and removes it. Nothing is stored and no frame is sent.
   */
  async testConnection(coreId: string, ownerId = OPERATOR_ID): Promise<SharedConnectionResult> {
    await this.requireCore(coreId, ownerId);
    return this.probeIsolation(coreId, ownerId);
  }

  /**
   * Settings › Storage test-connection (#566): the same isolation probe as pairing. When `coreId` is set the
   * Core must exist; otherwise a throwaway probe id is used so the page can prove the bucket without picking a Core.
   */
  async testConfiguredConnection(coreId?: string, ownerId = OPERATOR_ID): Promise<SharedConnectionResult> {
    if (coreId) {
      await this.requireCore(coreId, ownerId);
      return this.probeIsolation(coreId, ownerId);
    }
    return this.probeIsolation(`probe_${randomBytes(6).toString("hex")}`, ownerId);
  }

  private async probeIsolation(coreId: string, ownerId: number): Promise<SharedConnectionResult> {
    const { issuer, target } = await this.deps.issuer(ownerId);
    const key = await issuer.issue(coreId);
    const folder = coreFolderPrefix(target.prefix, coreId);
    const own = this.deps.s3({ target, folder, key, fetch: this.deps.fetch });
    const probe = `.panel-probe-${randomBytes(6).toString("hex")}`;
    const body = randomBytes(8).toString("hex");

    const result: SharedConnectionResult = {
      folder,
      expiresAt: key.expiresAt.getTime(),
      read: false,
      write: false,
      listOwn: false,
      reachOther: false,
    };
    try {
      await own.put(probe, body);
      result.write = true;
      result.read = new TextDecoder().decode((await own.get(probe)).body) === body;
      result.listOwn = (await own.list("")).some((e) => e.path === probe);
    } catch {
      // A step that threw stays false; the failure is the answer, and its message names nothing secret.
    } finally {
      await own.rm(probe).catch(() => undefined);
    }

    // Another Core's folder: an id this Panel never issued, under the same prefix. Every operation must be refused.
    const otherFolder = coreFolderPrefix(target.prefix, `core_${randomBytes(6).toString("hex")}`);
    const other = this.deps.s3({ target, folder: otherFolder, key, fetch: this.deps.fetch });
    const reached = await Promise.all([
      other.list("").then(() => true, () => false),
      other.get("probe").then(() => true, (e: { code?: string }) => e?.code === "not-found"),
      other.put(probe, body).then(() => true, () => false),
    ]);
    result.reachOther = reached.some(Boolean);
    if (result.reachOther) await other.rm(probe).catch(() => undefined);
    return result;
  }

  /**
   * After a master-key rotate: push a fresh 1-hour key to every attached Core that is connected.
   * Unreachable Cores get one when they reconnect (the existing status listener).
   */
  async reissueAll(ownerId = OPERATOR_ID): Promise<void> {
    for (const row of await findLiveSharedFolders(ownerId)) {
      if (this.deps.isConnected(row.coreId)) void this.refresh(row.coreId, ownerId, this.bump(row.coreId));
    }
  }

  /**
   * Per-Core rows for Settings › Storage (screen 08): folder size and key expiry from the server.
   * Size is the sum of object bytes under the Core's prefix, listed with a key issued for that Core.
   */
  async listStorageCores(ownerId = OPERATOR_ID): Promise<StorageCoreFolderView[]> {
    const cores = await listCores(ownerId);
    const folders = await findAllSharedFolders(ownerId);
    const byId = new Map(folders.map((r) => [r.coreId, r]));
    const out: StorageCoreFolderView[] = [];
    let issuerPack: { issuer: SharedKeyIssuer; target: StorageTarget } | null = null;
    try {
      issuerPack = await this.deps.issuer(ownerId);
    } catch {
      issuerPack = null;
    }
    for (const core of cores) {
      const row = byId.get(core.id);
      const prefix = row?.s3Prefix || (issuerPack ? coreFolderPrefix(issuerPack.target.prefix, core.id) : `${core.id}/`);
      const offline = !this.deps.isConnected(core.id);
      let sizeBytes: number | null = null;
      if (issuerPack && row && row.state !== "pending") {
        try {
          const key = await issuerPack.issuer.issue(core.id);
          const shared = this.deps.s3({ target: issuerPack.target, folder: prefix, key, fetch: this.deps.fetch });
          sizeBytes = await sumFolderBytes(shared);
        } catch {
          sizeBytes = null;
        }
      }
      out.push({
        coreId: core.id,
        label: core.label,
        prefix,
        sizeBytes,
        keyExpiresAt: row?.keyExpiresAt ?? null,
        state: (row?.state as StorageCoreFolderView["state"]) ?? "pending",
        offline,
        error: row?.lastError ?? null,
      });
    }
    return out;
  }

  // ─── Finishing the pairing ───────────────────────────────────────────────

  /**
   * The last, mandatory step of pairing from the Panel: prove the key, attach the Core's folder, and only then
   * mark the pairing finished. Any refusal leaves the Core pending, with the reason in the error.
   */
  async finishPairing(coreId: string, ownerId = OPERATOR_ID): Promise<CoreSharedFolderRow> {
    await this.requireCore(coreId, ownerId);
    const folderRow = await findSharedFolder(ownerId, coreId);
    if (!folderRow) throw new NotFoundError("This Core was not paired from a Panel that needs a Shared folder.");

    const result = await this.testConnection(coreId, ownerId);
    if (!result.read || !result.write || !result.listOwn || result.reachOther) {
      throw new SharedFolderError(
        result.reachOther
          ? `The key issued for ${result.folder} reaches another Core's folder, so the Shared folder was not attached.`
          : `The key issued for ${result.folder} could not read, write and list its own folder, so the Shared folder was not attached.`,
        "isolation-failed",
      );
    }
    await this.push(coreId, ownerId, "attach");
    const row = await findSharedFolder(ownerId, coreId);
    return row!;
  }

  // ─── Pushing keys ────────────────────────────────────────────────────────

  /**
   * Issue a key and push it. `attach` sends `sharedAttach`; `refresh` sends `sharedCredentials` and falls back to
   * `sharedAttach` when the Core says it is not attached (a Core that lost its key file). The row, and the next
   * refresh, are updated only once the Core has said `attached`.
   */
  private async push(coreId: string, ownerId: number, mode: "attach" | "refresh"): Promise<void> {
    const link = this.deps.link(coreId);
    if (!link) throw new SharedFolderError("This Core is not connected, so its Shared folder cannot be attached.", "not-connected");
    if (link.sharedCapability && link.sharedCapability() === null) {
      throw new SharedFolderError(
        "This Core cannot mount a Shared folder: update it (`actana update`) and try again.",
        "cannot-mount",
      );
    }
    const { issuer, target } = await this.deps.issuer(ownerId);
    const issuedAt = this.deps.now();
    const key = await issuer.issue(coreId);
    const folder = coreFolderPrefix(target.prefix, coreId);
    const credentials = { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, sessionToken: key.sessionToken };
    const expiresAt = key.expiresAt.toISOString();
    // Record the end of this key before it is sent: a push the Core accepts but whose answer is lost leaves the Core
    // holding a later key than the row would say, and delete trusts the row to know when the Core can no longer sync.
    // If the Core refuses the key the row only over-states, which delays a delete and never allows one early.
    const known = (await findSharedFolder(ownerId, coreId))?.keyExpiresAt ?? 0;
    if (key.expiresAt.getTime() > known) {
      await updateSharedFolder(ownerId, coreId, { keyExpiresAt: key.expiresAt.getTime() }, this.deps.now());
    }
    const reqId = () => `panel-shared-${randomBytes(6).toString("hex")}`;
    const send = async (frame: CoreLinkRequestFrame) =>
      statusOf(await link.request(frame, this.deps.requestTimeoutMs));
    const attachFrame = (): CoreLinkRequestFrame => ({
      type: "sharedAttach",
      reqId: reqId(),
      endpoint: target.endpoint,
      bucket: target.bucket,
      prefix: folder.replace(/\/+$/, ""),
      region: target.region,
      credentials,
      expiresAt,
    });

    // True only when the Core accepted a `sharedAttach` for this folder: the stored prefix is where the Core is
    // attached, so a plain `sharedCredentials` (which keeps whatever the Core is attached to) never rewrites it.
    let attachedHere = false;
    const attach = async (): Promise<CoreLinkSharedMountStatus> => {
      const answer = await send(attachFrame());
      attachedHere = answer.state === "attached";
      return answer;
    };
    let status: CoreLinkSharedMountStatus;
    if (mode === "attach") {
      status = await attach();
      if (status.state === "error" && status.code === "already-attached") {
        // Mounted somewhere this Panel did not record. It is asked to let go WITHOUT being given a key first: a detach
        // only copies S3 into `~/shared` and never deletes on either side, while a key makes the Core run a full sync
        // pass, which deletes here every file it synced before that is gone in S3 (a Core whose Core was deleted finds
        // its prefix empty). If it will not let go (its key has run out), it is left as it is and nothing is sent. Once it has let go (its state is cleared), the attach
        // below is fresh: a first pass copies and never deletes, and the row then names where the Core really is.
        // See the pairing-time table in the PR body and `shared-folders-attach-table.test.ts`.
        const letGoStatus = await send({ type: "sharedDetach", reqId: reqId(), keepLocalCopy: true });
        if (letGoStatus.state !== "detached" && !(letGoStatus.state === "error" && letGoStatus.code === "not-attached")) {
          throw new SharedFolderError(
            `This machine is still attached to a Shared folder from an earlier pairing and cannot let go of it (${describe(letGoStatus)}). ` +
              "Nothing was changed: the Panel will not give it a key, because a key makes it sync, and with that folder " +
              "empty or deleted it would delete the files in its own ~/shared. Once it can detach (its key valid), try again.",
            "core-refused",
          );
        }
        status = await attach();
      }
    } else {
      status = await send({ type: "sharedCredentials", reqId: reqId(), credentials, expiresAt });
      if (status.state === "error" && status.code === "not-attached") status = await attach();
    }
    if (status.state !== "attached") {
      throw new SharedFolderError(
        `The Core refused the Shared folder: ${describe(status)}.`,
        "core-refused",
      );
    }
    await updateSharedFolder(
      ownerId,
      coreId,
      {
        state: "attached",
        ...(attachedHere ? { s3Prefix: folder } : {}),
        keyExpiresAt: key.expiresAt.getTime(),
        lastError: null,
      },
      this.deps.now(),
    );
    this.attempts.delete(coreId);
    this.schedule(coreId, ownerId, refreshAtMs(key, issuedAt) - this.deps.now());
  }

  private schedule(coreId: string, ownerId: number, delayMs: number): void {
    const old = this.timers.get(coreId);
    if (old) this.deps.clearTimer(old);
    const gen = (this.generation.get(coreId) ?? 0) + 1;
    this.generation.set(coreId, gen);
    this.timers.set(
      coreId,
      this.deps.setTimer(() => {
        this.timers.delete(coreId);
        if (this.generation.get(coreId) !== gen) return;
        void this.refresh(coreId, ownerId, gen);
      }, Math.max(0, delayMs)),
    );
  }

  /** Stop keeping this Core's key fresh. Whatever a timer was about to do is dropped. */
  cancel(coreId: string): void {
    const t = this.timers.get(coreId);
    if (t) this.deps.clearTimer(t);
    this.timers.delete(coreId);
    this.generation.set(coreId, (this.generation.get(coreId) ?? 0) + 1);
    this.attempts.delete(coreId);
  }

  private async refresh(coreId: string, ownerId: number, gen: number): Promise<void> {
    try {
      await this.push(coreId, ownerId, "refresh");
    } catch (err) {
      if (this.generation.get(coreId) !== gen) return;
      const n = (this.attempts.get(coreId) ?? 0) + 1;
      this.attempts.set(coreId, n);
      const reason = err instanceof Error ? err.message : "the key could not be pushed";
      // Surfaced on the Core, and logged: a Core whose key cannot be replaced stops syncing when it ends.
      await updateLiveSharedFolder(ownerId, coreId, { state: "error", lastError: reason }, this.deps.now()).catch(() => undefined);
      this.deps.log(`[panel] core ${coreId}: Shared folder key push failed (attempt ${n}): ${reason}`);
      const delays = this.deps.retryDelaysMs;
      this.schedule(coreId, ownerId, delays[Math.min(n - 1, delays.length - 1)]!);
    }
  }

  /**
   * Start keeping every attached Core's key fresh: at boot, and whenever a Core's link comes back (a Core that
   * restarted, or one whose key ran out while it was away, gets a new key at once).
   */
  async start(ownerId = OPERATOR_ID): Promise<() => void> {
    const off = coreLinkManager().onStatusChange((status) => {
      if (status.state !== "connected") return;
      void findSharedFolder(ownerId, status.coreId).then((row) => {
        if (row && row.state !== "pending") void this.refresh(status.coreId, ownerId, this.bump(status.coreId));
      });
    });
    for (const row of await findLiveSharedFolders(ownerId)) {
      // A link that is still coming up announces itself through the listener above, which refreshes then.
      if (this.deps.isConnected(row.coreId)) void this.refresh(row.coreId, ownerId, this.bump(row.coreId));
    }
    return () => {
      off();
      for (const coreId of [...this.timers.keys()]) this.cancel(coreId);
    };
  }

  private bump(coreId: string): number {
    const gen = (this.generation.get(coreId) ?? 0) + 1;
    this.generation.set(coreId, gen);
    return gen;
  }

  // ─── Unpair and delete ───────────────────────────────────────────────────

  /**
   * Tell the Core to let go of S3: `sharedDetach` copies S3 into `~/shared` and stops, and the Core keeps its home
   * folder with every file. Returns what happened instead of throwing, because an unreachable Core must still be
   * forgettable: the key it holds ends within the hour.
   */
  async detach(coreId: string): Promise<{ detached: boolean; error?: string }> {
    this.cancel(coreId);
    const { detached, error } = await this.sendDetach(coreId);
    return error === undefined ? { detached } : { detached, error };
  }

  /** The `sharedDetach` request alone: the refresh timer is left running, for a caller that may not go on. */
  private async sendDetach(coreId: string): Promise<{ detached: boolean; error?: string; reached?: boolean }> {
    const link = this.deps.link(coreId);
    if (!link) return { detached: false, error: "the Core is not connected; its key ends within the hour", reached: false };
    if (link.sharedCapability && link.sharedCapability() === null) return { detached: true, reached: true };
    try {
      const status = statusOf(
        await link.request({ type: "sharedDetach", reqId: `panel-shared-${randomBytes(6).toString("hex")}`, keepLocalCopy: true }, this.deps.requestTimeoutMs),
      );
      if (status.state === "detached") return { detached: true, reached: true };
      if (status.state === "error" && status.code === "not-attached") return { detached: true, reached: true };
      return { detached: false, error: status.state === "error" ? `${status.code}: ${status.message}` : status.state, reached: true };
    } catch (err) {
      return { detached: false, error: err instanceof Error ? err.message : "the detach request failed", reached: true };
    }
  }

  /** What an operator has to type to delete this Core: the exact prefix of its folder, or its id when it has none. */
  async deleteConfirmation(coreId: string, ownerId = OPERATOR_ID): Promise<string> {
    await this.requireCore(coreId, ownerId);
    const row = await findSharedFolder(ownerId, coreId);
    return row?.s3Prefix ? row.s3Prefix : coreId;
  }

  /**
   * Delete a Core: after a confirmation that is exactly its prefix, remove the Core row, empty `~/shared` on its machine
   * and empty its S3 prefix with a key issued for that Core. The key is limited to `<prefix>/<core id>/` by the role, and the SDK's
   * S3 mode cannot leave the prefix it was made with, so no other Core's folder is touched. A prefix that could
   * not be emptied is an error that names it (the Core is already gone from the registry).
   *
   * **The machine's folder (ADR 0041 D12, D38)** is emptied only while the Core's link is up and the Core has let go of S3
   * (answered `detached` or `not-attached`), through its Files API: its children only, never through a link. A Core that is
   * not connected does not stop the delete: it finishes on the Panel and the answer says `machineFolder.state` is `kept`,
   * with the reason, for the screen to state. Unpair never calls this: it keeps the machine copy.
   */
  async deleteCore(coreId: string, confirmation: string, ownerId = OPERATOR_ID): Promise<DeleteCoreResult> {
    const expected = await this.deleteConfirmation(coreId, ownerId);
    if (confirmation !== expected) {
      throw new SharedFolderError(`Type the prefix ${expected} exactly to delete this Core and its Shared folder.`, "confirmation");
    }
    const row = await findSharedFolder(ownerId, coreId);
    const folder = row?.s3Prefix ?? "";
    // The Core must stop syncing before anything is emptied: one still syncing would mirror a half-done delete. A Core that
    // answered and refused is asked again later (409). A Core that cannot be reached does not hold the delete: the
    // Panel finishes, and the machine's copy is reported as kept.
    const letGo = await this.sendDetach(coreId);
    if (folder && !letGo.detached && letGo.reached && (row?.keyExpiresAt ?? 0) > this.deps.now()) {
      throw new SharedFolderError(
        `The Core has not let go of ${folder} (${letGo.error ?? "no answer"}), so nothing was deleted: it is still syncing. ` +
          `Try again in a moment, or after its key ends at ${new Date(row!.keyExpiresAt!).toISOString()}.`,
        "still-attached",
      );
    }
    // The machine's folder, before the Core's credentials go with its row.
    let machineFolder: MachineFolderResult;
    if (!letGo.detached) {
      machineFolder = { state: "kept", reason: `the Core could not be reached (${letGo.error ?? "no answer"})`, removed: 0 };
    } else if (!this.deps.isConnected(coreId)) {
      machineFolder = { state: "kept", reason: "the Core is not connected", removed: 0 };
    } else {
      try {
        machineFolder = await this.deps.emptyMachineFolder(coreId, ownerId);
      } catch (err) {
        machineFolder = { state: "kept", reason: err instanceof Error ? err.message : "the Core did not answer", removed: 0 };
      }
    }
    if (machineFolder.state === "kept") this.deps.log(`[panel] core ${coreId}: ~/shared on the machine was kept: ${machineFolder.reason}`);
    this.cancel(coreId);
    coreLinkManager().hangup(coreId);
    await removeCore(coreId, ownerId);
    if (!folder) return { prefix: null, removed: 0, machineFolder };

    try {
      const { issuer, target } = await this.deps.issuer(ownerId);
      // The folder is the one the Core was attached to (a refresh never rewrites it), so a prefix edited since cannot
      // move it; it must still be this Core's own folder, whatever the row says.
      if (!folder.endsWith(`/${coreId}/`)) {
        throw new ValidationError(`the stored folder ${folder} is not this Core's folder`);
      }
      const key = await issuer.issue(coreId);
      const shared = this.deps.s3({ target, folder, key, fetch: this.deps.fetch });
      let removed = 0;
      // The root cannot be removed, so each child goes. A listing is a page; list again until it is empty.
      for (let pass = 0; ; pass += 1) {
        const children = await shared.list("");
        if (children.length === 0) break;
        if (pass >= MAX_DELETE_PASSES) throw new Error("the folder is not getting empty");
        for (const child of children) {
          await shared.rm(child.kind === "folder" ? `${child.path}/` : child.path);
          removed += 1;
        }
      }
      return { prefix: folder, removed, machineFolder };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      this.deps.log(`[panel] core ${coreId}: could not empty ${folder}: ${reason}`);
      throw new SharedFolderError(
        `The Core was removed, but its S3 prefix ${folder} could not be emptied: ${reason}. Remove it by hand.` +
          (machineFolder.state === "kept" ? ` ~/shared on the machine was kept: ${machineFolder.reason}.` : ""),
        "prefix-delete-failed",
      );
    }
  }

  private async requireCore(coreId: string, ownerId: number): Promise<void> {
    if (!(await getCore(coreId, ownerId))) throw new NotFoundError("no such Core");
  }
}

let singleton: SharedFolders | null = null;

export function sharedFolders(): SharedFolders {
  if (!singleton) singleton = new SharedFolders();
  return singleton;
}

/** @internal */
export function resetSharedFoldersForTests(next: SharedFolders | null = null): void {
  singleton = next;
}

function viewOf(row: CoreSharedFolderRow): CoreSharedFolder {
  return {
    state: row.state as CoreSharedFolder["state"],
    prefix: row.s3Prefix || null,
    keyExpiresAt: row.keyExpiresAt,
    error: row.lastError,
  };
}

/** Every Core's folder state in one query, by Core id: what the Cores list reads on every poll. */
export async function describeSharedFolders(ownerId = OPERATOR_ID): Promise<Map<string, CoreSharedFolder>> {
  return new Map((await findAllSharedFolders(ownerId)).map((row) => [row.coreId, viewOf(row)]));
}

/** The folder state a browser may see: where it stands and when the key ends, nothing of the key. */
export async function describeSharedFolder(coreId: string, ownerId = OPERATOR_ID): Promise<CoreSharedFolder | undefined> {
  const row = await findSharedFolder(ownerId, coreId);
  return row ? viewOf(row) : undefined;
}

/** Sum file sizes under a Core's Shared folder by walking `list` (direct children only per call). */
async function sumFolderBytes(shared: CoreShared, path = ""): Promise<number> {
  let total = 0;
  const entries = await shared.list(path);
  for (const entry of entries) {
    if (entry.kind === "file") {
      total += entry.size ?? 0;
    } else {
      total += await sumFolderBytes(shared, entry.path);
    }
  }
  return total;
}
