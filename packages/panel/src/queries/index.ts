import { useEffect } from "react";
import { hashKey, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "~/lib/api";
import { retainProjectScope, watchProjectScope } from "~/lib/visible-project-scope";
import { setHookToken } from "~/lib/hook-token";
import { syncDefaultRuntimeDefaults } from "~/lib/default-model-store";
import { getPanelBridge } from "~/lib/panel-bridge";
import {
  readCachedGroups,
  readCachedProjects,
  readCachedSettings,
} from "~/lib/shell-query-cache";
import type { CoreLinkTaskSnapshot } from "@actana/sdk/core-link-frames";
import type { Task } from "~/db/schema";
import type { Harness } from "@actana/shared/domain";
import { projectRowFromSnapshot } from "~/shared/projects";

export const queryKeys = {
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  groups: ["groups"] as const,
  tasks: (projectId: string) => ["projects", projectId, "tasks"] as const,
  // Deliberately outside the `["projects", projectId, …]` tree: these two
  // buckets belong to the Archived view, and folding them under the project
  // key would sweep them into every `invalidateProject()` — including the
  // count, which has no fetcher of its own to answer with (see
  // `useCoreArchivedTaskCount`).
  coreArchivedTasks: (projectId: string, coreId: string) =>
    ["core-archived-tasks", coreId, projectId] as const,
  coreArchivedTaskCount: (projectId: string, coreId: string) =>
    ["core-archived-task-count", coreId, projectId] as const,
  settings: ["settings"] as const,
  hookToken: ["hook-token"] as const,
  keybindings: ["keybindings"] as const,
  usage: (days: number) => ["usage", days] as const,
  claudeUsageLimits: ["claude-usage-limits"] as const,
  providerUsage: (idsKey: string) => ["provider-usage", idsKey] as const,
  harnessAccounts: ["harness-launchers", "accounts"] as const,
  harnessLatestVersions: ["harness-launchers", "latest-versions"] as const,
  updateCheck: ["update-check"] as const,
};

export const projectsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.projects,
    queryFn: async () => (await api.listProjects()).projects,
    placeholderData: readCachedProjects,
  });

export const projectQueryOptions = (id: string, opts?: { coreId?: string | null }) => {
  const coreId = opts?.coreId ?? null;
  return queryOptions({
    // A Core's rows get their own cache bucket; the Panel's own rows keep the
    // untagged key so existing invalidations don't need to thread coreId
    // through.
    queryKey: coreId
      ? ([...queryKeys.project(id), "core", coreId] as const)
      : queryKeys.project(id),
    queryFn: async () => {
      if (coreId) {
        // A Core-owned project id doesn't exist in the Panel's DB, so
        // `api.getProject` would 404 and error the header. Ask the Core:
        // `listProjects` gives us every project on it and we pick the one
        // whose id matches. There is no `getProject` on the panel link — a
        // small list is cheap and stays consistent with list-based
        // invalidation.
        const bridge = getPanelBridge();
        if (!bridge) throw new Error("panel link unavailable");
        // A failed presentation read costs the operator's filing, not the
        // project — degrade to unfiled rather than failing a read whose Core
        // facts arrived fine. `useRemotePinnedProjects` degrades the same way.
        const [projects, presentation] = await Promise.all([
          bridge.listProjects(coreId),
          api
            .listProjectPresentation()
            .then((r) => r.presentation)
            .catch(() => []),
        ]);
        const snapshot = projects.find((p) => p.projectId === id);
        if (!snapshot) throw new Error(`project ${id} not found on core ${coreId}`);
        // We just read what this Core has; anything the Panel still files under
        // a project it no longer lists is an orphan nothing else collects
        // (issue 98). Fire-and-forget — a failed sweep must not fail the read.
        void api
          .pruneProjectPresentation(coreId, projects.map((p) => p.projectId))
          .catch(() => undefined);
        return projectRowFromSnapshot(
          snapshot,
          presentation.find((row) => row.projectId === id),
        );
      }
      return (await api.getProject(id)).project;
    },
  });
};

export const groupsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.groups,
    queryFn: async () => (await api.listGroups()).groups,
    placeholderData: readCachedGroups,
  });

// Cache key for a task list bucket, coreId-aware. The Panel's own rows stay
// untagged so existing invalidations still match; a Core's rows live in a
// distinct `[..., "core", coreId]` bucket. Used by both the query (see
// `tasksQueryOptions`) and the optimistic-task helpers so writes land in the
// same bucket the query reads from.
export function tasksCacheKey(
  projectId: string,
  coreId?: string | null,
) {
  const base = queryKeys.tasks(projectId);
  if (!coreId) return base;
  return [...base, "core", coreId] as const;
}

// Flattened core-link snapshot → the UI's `Task` row. A Core's task only
// travels the wire as a snapshot (see CoreLinkTaskSnapshot), but the Panel is
// typed on its own DB shape. Fields the snapshot doesn't carry
// get safe defaults; the Core stays authoritative for the ones it does.
export function remoteTaskFromSnapshot(snapshot: CoreLinkTaskSnapshot): Task {
  return {
    id: snapshot.taskId,
    projectId: snapshot.projectId,
    title: snapshot.title,
    // The Core owns this flag (issue 84). Synthesizing `false` told the card
    // that every Core-owned Session was un-renamed, so an operator's rename
    // read as generator fair game again on the next reload.
    titleManuallySet: snapshot.titleManuallySet,
    icon: snapshot.icon,
    agent: snapshot.agent as Harness,
    status: snapshot.status as Task["status"],
    branch: "main",
    preview: "",
    lines: 0,
    archived: snapshot.archived,
    pinned: snapshot.pinned,
    claudeSessionId: snapshot.claudeSessionId,
    claudeSkipPermissions: false,
    claudeBareSession: false,
    createdAt: snapshot.updatedAt,
    updatedAt: snapshot.updatedAt,
  };
}

export const tasksQueryOptions = (
  projectId: string,
  opts?: { coreId?: string | null },
) => {
  const coreId = opts?.coreId ?? null;
  return queryOptions({
    // See `tasksCacheKey` — same rule, shared with the optimistic-task
    // helpers so writes land in the same bucket the query reads from.
    queryKey: tasksCacheKey(projectId, coreId),
    queryFn: async ({ client }) => {
      // Stamped before the read, asked after it: an uncached pin can answer
      // long after the operator clicked away from it (issue 381). A visit
      // stamp, not a visibility check — during A → B → A → B this read may be
      // the one that was cancelled on the way out, landing while B is on
      // screen again and looking current.
      const readIsStale = watchProjectScope(projectId, coreId);
      if (coreId) {
        // Core task loading over the panel link (ADR-0005): the
        // Core on `coreId` owns the rows, so the query goes down that
        // Core's core-link and its flattened snapshots map back into the UI's
        // `Task` shape. An unreachable Core surfaces the router's error as a
        // normal query error — the panel already knows how to render that.
        const bridge = getPanelBridge();
        if (!bridge) return [];
        const { tasks, archivedCount } = await bridge.listTasks(coreId, projectId);
        // The archived count rides this answer (ADR 0019) but belongs to a
        // different consumer — the Archived tab, which needs it while the
        // active view is showing. Park it in its own bucket rather than
        // widening this list's shape for every reader of it.
        //
        // Not parked by a read whose visit is over. The list itself is safe
        // without this — react-query drops a cancelled fetch's result — but
        // this write is the fetcher's own, so nothing else stops it, and the
        // bucket it writes to has no fetcher to correct it
        // (`useCoreArchivedTaskCount` is `enabled: false`). Left ungated, an
        // abandoned read landing after the read that replaced it would leave
        // the Archived tab labelled from rows the list no longer holds.
        if (!readIsStale()) {
          client.setQueryData(queryKeys.coreArchivedTaskCount(projectId, coreId), archivedCount);
        }
        return tasks.map(remoteTaskFromSnapshot);
      }
      // A Panel-owned project's list carries its archived rows already, so
      // the Archived view derives both count and rows from it — no second
      // read path, and nothing to park.
      return (await api.listTasks(projectId)).tasks;
    },
  });
};

/**
 * A Core project's archived Sessions — the Archived view's own read path
 * (ADR 0019). Fetched over the dedicated `archivedTasksList` frame, and only
 * while `enabled` (the view being open), so opening a project pulls no
 * archived rows. Panel-owned projects never use this: their archived rows are
 * already in the task list.
 */
export const archivedTasksQueryOptions = (
  projectId: string,
  opts: { coreId: string; enabled: boolean },
) =>
  queryOptions({
    queryKey: queryKeys.coreArchivedTasks(projectId, opts.coreId),
    queryFn: async () => {
      const bridge = getPanelBridge();
      if (!bridge) return [];
      const tasks = await bridge.listArchivedTasks(opts.coreId, projectId);
      return tasks.map(remoteTaskFromSnapshot);
    },
    enabled: opts.enabled,
  });

export const settingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings,
    queryFn: async () => {
      const settings = await api.getSettings();
      // Mirror the default runtime into a module cache so commandForTask can append
      // the model flag without prop-drilling settings through the terminal store.
      syncDefaultRuntimeDefaults(settings);
      return settings;
    },
    placeholderData: () => {
      const cached = readCachedSettings();
      if (cached) syncDefaultRuntimeDefaults(cached);
      return cached;
    },
  });

// The agent hook token. Owned by each Core's Core — see server/hook-auth.ts
// for the Panel's own verifier. Stays cached
// indefinitely; only invalidated when ApiSettingsPage rotates it. It
// authenticates spawned agents' hook callbacks, never the Operator.
// The hook token is the Core's business (each Core owns the env of the PTYs
// it spawns), so the browser has nothing to fetch. Kept as a query so the
// existing `useHookToken()` call sites keep their shape.
export const hookTokenQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.hookToken,
    queryFn: async (): Promise<string | null> => {
      setHookToken(null);
      return null;
    },
    staleTime: Infinity,
  });

export const DEFAULT_USAGE_DAYS = 30;
const USAGE_STALE_MS = 30_000;

// /api/usage waits a short budget for its JSONL sync, so warm responses are
// fully fresh (usage.controller). Only the first-ever cold sync exceeds the
// budget: the server then answers from the current DB and flags `syncing: true`
// while it finishes in the background. We poll on a short interval while that
// flag is set to pick up the converged numbers, then stop. No perpetual polling
// in the steady state, where syncing is always false.
const USAGE_SYNCING_REFETCH_MS = 2_000;

export const usageQueryOptions = (days: number = DEFAULT_USAGE_DAYS) =>
  queryOptions({
    queryKey: queryKeys.usage(days),
    queryFn: async () => api.getUsage(days),
    staleTime: USAGE_STALE_MS,
    refetchInterval: (query) =>
      query.state.data?.syncing ? USAGE_SYNCING_REFETCH_MS : false,
    refetchIntervalInBackground: false,
  });

// Claude usage limits come from a local file the statusline tap rewrites every
// few seconds (src/shared/statusline-tap.ts), so polling the server is cheap —
// keep the top bar close to live without requiring a manual reload.
const CLAUDE_USAGE_LIMITS_STALE_MS = 20_000;
const CLAUDE_USAGE_LIMITS_REFETCH_MS = 30_000;

export const claudeUsageLimitsQueryOptions = (enabled: boolean) =>
  queryOptions({
    queryKey: queryKeys.claudeUsageLimits,
    queryFn: async () => api.getClaudeUsageLimits(),
    enabled,
    staleTime: CLAUDE_USAGE_LIMITS_STALE_MS,
    refetchInterval: enabled ? CLAUDE_USAGE_LIMITS_REFETCH_MS : false,
    refetchIntervalInBackground: false,
  });

const PROVIDER_USAGE_STALE_MS = 20_000;
const PROVIDER_USAGE_REFETCH_MS = 45_000;

export const providerUsageQueryOptions = (
  enabled: boolean,
  providerIds: readonly string[],
) => {
  const idsKey = providerIds.join(",");
  return queryOptions({
    queryKey: queryKeys.providerUsage(idsKey),
    queryFn: async () => api.getProviderUsage(providerIds),
    enabled: enabled && providerIds.length > 0,
    staleTime: PROVIDER_USAGE_STALE_MS,
    refetchInterval: enabled ? PROVIDER_USAGE_REFETCH_MS : false,
    refetchIntervalInBackground: false,
  });
};

// Local auth files rarely change while the settings page is open.
const HARNESS_ACCOUNTS_STALE_MS = 300_000;
// Aligned with the server-side npm registry cache TTL (1h). Mounting the
// Providers page therefore performs the "check all on open" pass at most
// once an hour; per-row refreshes go through api.getHarnessLatestVersions
// with refresh=true.
const HARNESS_LATEST_VERSIONS_STALE_MS = 3_600_000;

export const harnessAccountsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.harnessAccounts,
    queryFn: async () => (await api.getHarnessAccounts()).accounts,
    staleTime: HARNESS_ACCOUNTS_STALE_MS,
  });

export const harnessLatestVersionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.harnessLatestVersions,
    queryFn: async () => (await api.getHarnessLatestVersions()).versions,
    staleTime: HARNESS_LATEST_VERSIONS_STALE_MS,
  });

// The server answers from a file it refreshes at most once a day, so anything
// shorter here would only re-read the same three fields. A day-stale banner is
// exactly as useful as a fresh one — nobody needs to learn about a release in
// the first minute.
const UPDATE_CHECK_STALE_MS = 3_600_000;

export const updateCheckQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.updateCheck,
    queryFn: () => api.getUpdateCheck(),
    staleTime: UPDATE_CHECK_STALE_MS,
  });

/**
 * Tie one project-scoped query to the project+core that is actually on screen.
 *
 * Reading an uncached pin is slower than clicking away from it. During
 * A then B then A, B's project and task reads are still in flight when the URL
 * is already back on A, and what they were going to materialize — B's
 * sessions, B's archived count, the focus that follows them — would land on
 * A's URL (issue 381).
 *
 * While the query is being read by something on screen the scope is retained,
 * so a cold pin the operator stays on loads exactly as before — the 30s
 * `staleTime` is untouched, and nothing here makes a read start any later.
 * When the last reader of a scope goes away, an *in-flight* fetch for it is
 * cancelled: react-query reverts the query to the state it had before the
 * fetch, and the answer, whenever it turns up, is discarded rather than
 * written. Coming back to that pin later simply reads it again.
 *
 * Only a fetch in flight is cancelled. A settled query keeps its data, so
 * leaving a project never throws away rows the operator would see on return.
 *
 * Cancelling is not the whole guard, because a cancelled fetch's promise still
 * resolves — the panel link has nothing to abort — and its fetcher runs to the
 * end. Anything a fetcher writes for itself is guarded by
 * {@link watchProjectScope} instead; see `tasksQueryOptions`.
 */
function useScopedToVisibleProject(
  queryKey: readonly unknown[],
  projectId: string,
  coreId: string | null,
): void {
  const queryClient = useQueryClient();
  // The key is rebuilt every render; its hash is what actually changes.
  const keyHash = hashKey(queryKey);
  useEffect(() => {
    // `useTasks("")` is how the grid's hidden-session bar asks before it has a
    // scope at all — no project, nothing to keep on screen.
    if (!projectId) return;
    return retainProjectScope(projectId, coreId, {
      // Two readers of one key (the board's list and a pane's row) are one
      // thing to cancel, and a pane remounting through a visit must not leave
      // another copy of this closure behind.
      readerKey: keyHash,
      onLeft: () => {
        // Nothing in flight is nothing to abandon: a settled query keeps its
        // rows, so leaving never costs the operator the cache they come back to.
        if (queryClient.isFetching({ queryKey, exact: true }) === 0) return;
        // `revert: true` (the default) puts the query back the way it was before
        // this fetch, and the answer is dropped when it eventually turns up.
        void queryClient.cancelQueries({ queryKey, exact: true });
      },
    });
    // `keyHash` stands in for `queryKey` in the deps: the key is rebuilt every
    // render, its hash only changes when the key really does.
  }, [queryClient, projectId, coreId, keyHash]);
}

export const useProjects = () => useQuery(projectsQueryOptions());
export const useProject = (id: string, opts?: { coreId?: string | null }) => {
  const options = projectQueryOptions(id, opts);
  useScopedToVisibleProject(options.queryKey, id, opts?.coreId ?? null);
  return useQuery(options);
};
export const useGroups = () => useQuery(groupsQueryOptions());
export const useTasks = (
  projectId: string,
  opts?: { coreId?: string | null },
) => {
  const options = tasksQueryOptions(projectId, opts);
  useScopedToVisibleProject(options.queryKey, projectId, opts?.coreId ?? null);
  return useQuery(options);
};
/**
 * A Core project's archived Sessions. A null `coreId` is a Panel-owned
 * project, which sources them from its own task list — the query stays
 * disabled and never reaches the panel link.
 */
export const useArchivedTasks = (
  projectId: string,
  opts: { coreId: string | null; enabled: boolean },
) =>
  useQuery(
    archivedTasksQueryOptions(projectId, {
      coreId: opts.coreId ?? "",
      enabled: !!opts.coreId && opts.enabled,
    }),
  );

/**
 * How many archived Sessions a Core project holds.
 *
 * The number arrives on the `tasksList` answer (ADR 0019) and is parked in
 * this bucket by {@link tasksQueryOptions}' fetcher, because its consumers —
 * the Archived tab's gating and label, the "View archived" tooltip, the
 * auto-exit effect, the delete-confirm dialog — all read it while the *active*
 * view is showing. So this query never fetches: `enabled: false` leaves the
 * bucket to its writer, and the subscription is what re-renders the tab when
 * the number moves. Zero until the first task list lands, and for a
 * Panel-owned project (which counts its own rows instead).
 */
export const useCoreArchivedTaskCount = (projectId: string, coreId: string | null): number =>
  useQuery({
    queryKey: queryKeys.coreArchivedTaskCount(projectId, coreId ?? ""),
    queryFn: () => 0,
    enabled: false,
    initialData: 0,
  }).data;

/**
 * Per-row task subscription. Structural sharing keeps an unchanged row's
 * identity stable across list refetches, so a consumer (e.g. a terminal pane
 * header) re-renders only when ITS task changes — not on every task:* event.
 *
 * `coreId` names the bucket, exactly as it does for {@link useTasks}: a Core's
 * rows live in the tagged bucket and the Panel's own in the untagged one, and
 * a pane that asked the wrong one read a list that was never going to arrive.
 */
export const useTask = (
  projectId: string,
  taskId: string,
  opts?: { coreId?: string | null },
) => {
  const coreId = opts?.coreId ?? null;
  const options = tasksQueryOptions(projectId, { coreId });
  // A pane reading one row is a live reader of the same bucket the board
  // reads, so it holds the scope open too — otherwise the board unmounting
  // would cancel a fetch this pane is still waiting on.
  useScopedToVisibleProject(options.queryKey, projectId, coreId);
  return useQuery({
    ...options,
    select: (tasks) => tasks.find((t) => t.id === taskId),
  });
};
export const useSettings = () => useQuery(settingsQueryOptions());
export const useHookToken = () => useQuery(hookTokenQueryOptions());
export const useUsage = (days: number = DEFAULT_USAGE_DAYS) =>
  useQuery(usageQueryOptions(days));
export const useClaudeUsageLimits = (enabled: boolean) =>
  useQuery(claudeUsageLimitsQueryOptions(enabled));
export const useProviderUsage = (enabled: boolean, providerIds: readonly string[]) =>
  useQuery(providerUsageQueryOptions(enabled, providerIds));
export const useHarnessAccounts = () => useQuery(harnessAccountsQueryOptions());
export const useHarnessLatestVersions = () => useQuery(harnessLatestVersionsQueryOptions());
export const useUpdateCheck = () => useQuery(updateCheckQueryOptions());
