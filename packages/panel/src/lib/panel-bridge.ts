import { PanelLinkClient } from "./panel-link-client";
import { corePtyBridgeFor, type CorePtyBridge } from "./core-pty-bridge";
import type {
  CoreLinkAgentAvailabilityMap,
  CoreLinkDirListing,
  CoreLinkEvent,
  CoreLinkProjectMutation,
  CoreLinkProjectSnapshot,
  CoreLinkSessionSnapshot,
  CoreLinkTaskMutation,
  CoreLinkTaskSnapshot,
} from "@actana/shared/core-link-frames";
import type { CoreLinkAnswer as Answer } from "~/shared/panel-link";
import type { CoreDialStatus } from "~/shared/cores";

/**
 * The Panel UI's bridge — the one surface through which components reach a
 * Core.
 *
 * Every member below is a frame on the tab's panel link: the service holds the
 * core-link and the browser is genuinely a browser.
 *
 * Reads, terminals, and writes all ride the link. There is no second write
 * path: a mutation is a frame addressed to the Core that owns the row
 * (ADR 0004), so the Harness is the only process that ever touches its own
 * database, and two tabs looking at the same Core see the same answer because
 * they asked the same machine.
 */
export type PanelBridge = {
  /** True while the tab's link is up. False during a reconnect. */
  isConnected(): boolean;

  /** List a Core's projects. Live query — the Panel persists none of this. */
  listProjects(coreId: string): Promise<CoreLinkProjectSnapshot[]>;
  /** List a Core's active tasks, optionally scoped to one project. */
  listTasks(coreId: string, projectId?: string): Promise<CoreLinkTaskSnapshot[]>;
  /** List a Core's active sessions, optionally scoped to one project. */
  listSessions(coreId: string, projectId?: string): Promise<CoreLinkSessionSnapshot[]>;
  /** A Core's CLI availability snapshot; live changes arrive on {@link onEvent}. */
  listAgentAvailability(coreId: string): Promise<CoreLinkAgentAvailabilityMap>;

  /**
   * Create / rename / archive / pin a project on the Core that owns it.
   * Rejects with the Harness's message when the write fails — an unreachable
   * Core, or a path that machine says is not a folder. Resolves to `null` when
   * the mutation named a row that isn't there.
   */
  mutateProject(
    coreId: string,
    mutation: CoreLinkProjectMutation,
  ): Promise<CoreLinkProjectSnapshot | null>;
  /** Create / update a task (session) on the Core that owns it. */
  mutateTask(coreId: string, mutation: CoreLinkTaskMutation): Promise<CoreLinkTaskSnapshot | null>;

  /**
   * List folders on the Core's machine. `path` null means "start at that
   * machine's home" — the browser has no filesystem to offer and the operator's
   * own laptop is the wrong one.
   */
  listFolders(coreId: string, path: string | null): Promise<CoreLinkDirListing>;
  /** Create one folder on the Core's machine; resolves to its absolute path. */
  createFolder(coreId: string, parent: string, name: string): Promise<string>;

  /**
   * Watch a Core's live stream for as long as the returned function is unused.
   * Nothing arrives on {@link onEvent} for a Core nobody is watching — a tab
   * looking at one Core does not pay for the rest of the fleet.
   */
  watchCore(coreId: string): () => void;
  /** Domain events from every watched Core, tagged with their owner. */
  onEvent(cb: (msg: { coreId: string; event: CoreLinkEvent }) => void): () => void;
  /** Dial-status changes, pushed by the service as it finds them. */
  onDialStatus(cb: (status: CoreDialStatus) => void): () => void;
  /** Link up / link down, so a view can refetch across a gap. */
  onConnectionChange(cb: (connected: boolean) => void): () => void;

  /**
   * A Core's PTY transport — spawn, keystrokes, resize, kill, replay, and the
   * output stream. Stable per Core, so every terminal on that Core shares one
   * subscription and one reconnect reattach (see {@link CorePtyBridge}).
   */
  pty(coreId: string): CorePtyBridge;
};

function makeBridge(link: PanelLinkClient): PanelBridge {
  return {
    isConnected: () => link.isConnected(),
    listProjects: async (coreId) =>
      (await link.request<Answer<"projectsListResult">>(coreId, { type: "projectsList" })).projects,
    listTasks: async (coreId, projectId) =>
      (await link.request<Answer<"tasksListResult">>(coreId, { type: "tasksList", projectId }))
        .tasks,
    listSessions: async (coreId, projectId) =>
      (await link.request<Answer<"sessionsListResult">>(coreId, { type: "sessionsList", projectId }))
        .sessions,
    listAgentAvailability: async (coreId) =>
      (
        await link.request<Answer<"agentsAvailabilityListResult">>(coreId, {
          type: "agentsAvailabilityList",
        })
      ).availability,
    mutateProject: async (coreId, mutation) =>
      (
        await link.request<Answer<"projectsMutateResult">>(coreId, {
          type: "projectsMutate",
          mutation,
        })
      ).project,
    mutateTask: async (coreId, mutation) =>
      (await link.request<Answer<"tasksMutateResult">>(coreId, { type: "tasksMutate", mutation }))
        .task,
    listFolders: async (coreId, path) =>
      (await link.request<Answer<"dirListResult">>(coreId, { type: "dirList", path })).listing,
    createFolder: async (coreId, parent, name) =>
      (await link.request<Answer<"dirCreateResult">>(coreId, { type: "dirCreate", parent, name }))
        .path,
    watchCore: (coreId) => link.watch(coreId),
    onEvent: (cb) => link.onEvent(cb),
    onDialStatus: (cb) => link.onDialStatus(cb),
    onConnectionChange: (cb) => link.onConnectionChange(cb),
    pty: (coreId) => corePtyBridgeFor(link, coreId),
  };
}

let singleton: PanelBridge | null = null;

/**
 * The tab's bridge. Null while server-rendering, where there is no socket to
 * hold and no live data to show.
 */
export function getPanelBridge(): PanelBridge | null {
  if (typeof window === "undefined") return null;
  if (!singleton) singleton = makeBridge(new PanelLinkClient());
  return singleton;
}

/**
 * The PTY transport for one Core, or `null` when there is no Core to address
 * or no link to carry it (server rendering).
 */
export function getCorePtyBridge(coreId: string | null | undefined): CorePtyBridge | null {
  // No Core, no transport. A pane with no `coreId` has no machine to run on —
  // there is no local Harness to fall back to (ADR 0010).
  if (!coreId) return null;
  return getPanelBridge()?.pty(coreId) ?? null;
}

/** @internal — tests that need a bridge over a fake link. */
export function __setPanelBridgeForTests(bridge: PanelBridge | null): void {
  singleton = bridge;
}

/** @internal — the bridge over an explicitly provided link (tests, tooling). */
export function createPanelBridge(link: PanelLinkClient): PanelBridge {
  return makeBridge(link);
}
