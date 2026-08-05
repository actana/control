import { useMemo } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "~/lib/api";
import { setHookToken } from "~/lib/hook-token";
import { syncDefaultRuntimeDefaults } from "~/lib/default-model-store";
import { getPanelBridge } from "~/lib/panel-bridge";
import {
  readCachedGroups,
  readCachedProjects,
  readCachedSettings,
} from "~/lib/shell-query-cache";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/shared/core-link-frames";
import type { Task } from "~/db/schema";
import { TASK_STATUSES, type Harness, type TaskStatus } from "@actana/shared/domain";
import type { ProjectWithCounts } from "~/shared/projects";

export const queryKeys = {
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  groups: ["groups"] as const,
  tasks: (projectId: string) => ["projects", projectId, "tasks"] as const,
  settings: ["settings"] as const,
  hookToken: ["hook-token"] as const,
  keybindings: ["keybindings"] as const,
  userTerminals: (projectId: string) =>
    ["projects", projectId, "user-terminals"] as const,
  usage: (days: number) => ["usage", days] as const,
  claudeUsageLimits: ["claude-usage-limits"] as const,
  providerUsage: (idsKey: string) => ["provider-usage", idsKey] as const,
  harnessAccounts: ["harness-launchers", "accounts"] as const,
  harnessLatestVersions: ["harness-launchers", "latest-versions"] as const,
};

export const projectsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.projects,
    queryFn: async () => (await api.listProjects()).projects,
    placeholderData: readCachedProjects,
  });

// A Core's snapshot → the UI's `Project` row. The core-link only carries
// display metadata (name/path/icon/branch/pinned) — fields the Panel needs but
// the Core owns get safe defaults, and are read from the Panel's own
// mutation call sites when relevant.
function remoteProjectFromSnapshot(snapshot: CoreLinkProjectSnapshot): ProjectWithCounts {
  return {
    id: snapshot.projectId,
    name: snapshot.name,
    path: snapshot.path,
    icon: snapshot.icon,
    iconColor: snapshot.iconColor,
    imagePath: null,
    groupId: null,
    pinned: snapshot.pinned,
    pinnedOrder: null,
    launchUrl: null,
    // Remembered session settings are Core facts on the project row (issue 22),
    // so they come off the snapshot rather than defaulting to empty. Every
    // Panel connected to this Core therefore reads the same values.
    rememberHarnessSettings: snapshot.rememberHarnessSettings,
    savedHarness: (snapshot.savedHarness as Harness | null) ?? null,
    savedSkipPermissions: snapshot.savedSkipPermissions,
    savedBareSession: snapshot.savedBareSession,
    defaultGridView: snapshot.defaultGridView,
    createdAt: snapshot.updatedAt,
    updatedAt: snapshot.updatedAt,
    // Task counts / preview / githubUrl are decorated by the Panel's own DB —
    // a Core snapshot renders as zeros until the core-link grows per-project
    // counts. Header still mounts; no consumer crashes.
    taskCounts: {
      ...(Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>),
      total: 0,
      activeNonDone: 0,
    },
    preview: null,
    githubUrl: null,
    repoKey: null,
  };
}

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
        const projects = await bridge.listProjects(coreId);
        const snapshot = projects.find((p) => p.projectId === id);
        if (!snapshot) throw new Error(`project ${id} not found on core ${coreId}`);
        return remoteProjectFromSnapshot(snapshot);
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
    titleManuallySet: false,
    icon: snapshot.icon,
    agent: snapshot.agent as Harness,
    status: snapshot.status as Task["status"],
    branch: "main",
    preview: "",
    lines: 0,
    archived: snapshot.archived,
    pinned: snapshot.pinned,
    claudeSessionId: null,
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
    queryFn: async () => {
      if (coreId) {
        // Core task loading over the panel link (ADR-0005): the
        // Core on `coreId` owns the rows, so the query goes down that
        // Core's core-link and its flattened snapshots map back into the UI's
        // `Task` shape. An unreachable Core surfaces the router's error as a
        // normal query error — the panel already knows how to render that.
        const bridge = getPanelBridge();
        if (!bridge) return [];
        const tasks = await bridge.listTasks(coreId, projectId);
        return tasks.map(remoteTaskFromSnapshot);
      }
      return (await api.listTasks(projectId)).tasks;
    },
  });
};

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

export const userTerminalsQueryOptions = (projectId: string) =>
  queryOptions({
    queryKey: queryKeys.userTerminals(projectId),
    queryFn: async () => (await api.listUserTerminals(projectId)).terminals,
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

export const useProjects = () => useQuery(projectsQueryOptions());
export const useProject = (id: string, opts?: { coreId?: string | null }) =>
  useQuery(projectQueryOptions(id, opts));
export const useGroups = () => useQuery(groupsQueryOptions());
export const useTasks = (
  projectId: string,
  opts?: { coreId?: string | null },
) => useQuery(tasksQueryOptions(projectId, opts));
/**
 * Per-row task subscription. Structural sharing keeps an unchanged row's
 * identity stable across list refetches, so a consumer (e.g. a terminal pane
 * header) re-renders only when ITS task changes — not on every task:* event.
 */
export const useTask = (projectId: string, taskId: string) =>
  useQuery({
    ...tasksQueryOptions(projectId),
    select: (tasks) => tasks.find((t) => t.id === taskId),
  });
export const useSettings = () => useQuery(settingsQueryOptions());
export const useHookToken = () => useQuery(hookTokenQueryOptions());
export const useUserTerminalsQuery = (projectId: string) =>
  useQuery(userTerminalsQueryOptions(projectId));
export const useUsage = (days: number = DEFAULT_USAGE_DAYS) =>
  useQuery(usageQueryOptions(days));
export const useClaudeUsageLimits = (enabled: boolean) =>
  useQuery(claudeUsageLimitsQueryOptions(enabled));
export const useProviderUsage = (enabled: boolean, providerIds: readonly string[]) =>
  useQuery(providerUsageQueryOptions(enabled, providerIds));
export const useHarnessAccounts = () => useQuery(harnessAccountsQueryOptions());
export const useHarnessLatestVersions = () => useQuery(harnessLatestVersionsQueryOptions());
