import { useEffect } from "react";
import { hashKey, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "~/lib/api";
import { retainCoreScope, watchCoreScope } from "~/lib/visible-core-scope";
import { setHookToken } from "~/lib/hook-token";
import { syncDefaultRuntimeDefaults } from "~/lib/default-model-store";
import { getPanelBridge } from "~/lib/panel-bridge";
import { readCachedSettings } from "~/lib/shell-query-cache";
import type { CoreLinkSessionRow } from "@actana/shared/sdk-link-frames";
import type { Session } from "~/db/schema";
import type { Harness } from "@actana/shared/domain";

export const queryKeys = {
  /** Prefix over everything cached per Core, for a blanket invalidation. */
  coresAll: ["cores"] as const,
  /** A Core's active Sessions. A Session belongs to a Core and nothing narrower (ADR 0041 D1). */
  sessions: (coreId: string) => ["cores", coreId, "sessions"] as const,
  // Deliberately outside the `["cores", coreId, …]` tree: these two buckets
  // belong to the Archived view, and folding them under the sessions key would
  // sweep them into every sessions invalidation — including the count, which
  // has no fetcher of its own to answer with (see `useCoreArchivedSessionCount`).
  coreArchivedSessions: (coreId: string) => ["core-archived-sessions", coreId] as const,
  /** Prefix over every Core's archived bucket, for a blanket invalidation. */
  coreArchivedSessionsAll: ["core-archived-sessions"] as const,
  coreArchivedSessionCount: (coreId: string) => ["core-archived-session-count", coreId] as const,
  /** The Tasks board: every Task the owner has, across Cores. */
  tasks: ["tasks"] as const,
  task: (id: string) => ["tasks", id] as const,
  coreAgents: (coreId: string) => ["core-agents", coreId] as const,
  /** Everything the Files tab holds for a Core, for one invalidation after a write. */
  sharedFiles: (coreId: string) => ["shared-files", coreId] as const,
  sharedFolder: (coreId: string, path: string) => ["shared-files", coreId, "folder", path] as const,
  sharedFileDetails: (coreId: string, path: string) => ["shared-files", coreId, "details", path] as const,
  sharedFilesSummary: (coreId: string, since: number) => ["shared-files", coreId, "summary", since] as const,
  sharedFilesSearch: (coreId: string, query: string) => ["shared-files", coreId, "search", query] as const,
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

/**
 * What every Core-scoped read asks of react-query, on top of the client
 * defaults in `router.tsx`.
 *
 * The defaults are `staleTime: 30_000` with `refetchOnWindowFocus: false`
 * (`src/router.tsx:198` and `:200`), and together they are what leaves a
 * finished Session reading `running` (issue 484, symptom W2). Navigating away
 * unmounts the board; navigating back mounts it again, and `refetchOnMount`'s
 * default only refetches a query it considers STALE — so a return inside the
 * 30s window is served the cached, pre-finish list and never asks the Core.
 * Refocusing the tab does not ask either, because focus refetching is off.
 * Nothing else covers the gap: the Core's events only reach this tab while the
 * route that subscribes to them is mounted, which is exactly what it was not.
 *
 * `"always"` on both, and only here. Freshness matters for the rows the
 * operator is looking at — a Session's status is a live fact about a machine,
 * not a cached page — and it does not matter equally for usage rollups or the
 * update check, which set their own long `staleTime` and are left alone. The
 * global default stays as it is for everything else.
 *
 * Cost is a list read on mount and on focus, against a Core that is already
 * asked for this same list on every `pty:` event while a Session runs (see
 * `useCoreLiveQueries`).
 */
const CORE_SCOPED_FRESHNESS = {
  refetchOnMount: "always",
  refetchOnWindowFocus: "always",
} as const;

// Cache key for a Core's session list bucket. Used by both the query (see
// `sessionsQueryOptions`) and the optimistic-session helpers so writes land in
// the same bucket the query reads from.
export function sessionsCacheKey(coreId: string) {
  return queryKeys.sessions(coreId);
}

// Flattened core-link snapshot → the UI's `Session` row. A Core's session only
// travels the wire as a snapshot (see CoreLinkSessionRow), but the Panel is
// typed on its own DB shape. Fields the snapshot doesn't carry
// get safe defaults; the Core stays authoritative for the ones it does.
export function remoteSessionFromSnapshot(snapshot: CoreLinkSessionRow): Session {
  return {
    id: snapshot.sessionId,
    title: snapshot.title,
    // The Core owns this flag (issue 84). Synthesizing `false` told the card
    // that every Core-owned Session was un-renamed, so an operator's rename
    // read as generator fair game again on the next reload.
    titleManuallySet: snapshot.titleManuallySet,
    icon: snapshot.icon,
    agent: snapshot.agent as Harness,
    status: snapshot.status as Session["status"],
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

export const sessionsQueryOptions = (coreId: string) =>
  queryOptions({
    ...CORE_SCOPED_FRESHNESS,
    // See `sessionsCacheKey` — shared with the optimistic-session helpers so
    // writes land in the same bucket the query reads from.
    queryKey: sessionsCacheKey(coreId),
    // `useSessions("")` is how a caller asks before it has a Core at all.
    enabled: !!coreId,
    queryFn: async ({ client }) => {
      // Stamped before the read, asked after it: an uncached Core can answer
      // long after the operator clicked away from it (issue 381). A visit
      // stamp, not a visibility check — during A → B → A → B this read may be
      // the one that was cancelled on the way out, landing while B is on
      // screen again and looking current.
      const readIsStale = watchCoreScope(coreId);
      // Core session loading over the panel link (ADR-0005): the Core on
      // `coreId` owns the rows, so the query goes down that Core's core-link and
      // its flattened snapshots map back into the UI's `Session` shape. An
      // unreachable Core surfaces the router's error as a normal query error —
      // the panel already knows how to render that.
      const bridge = getPanelBridge();
      if (!bridge) return [];
      const { sessions, archivedCount } = await bridge.listSessionRows(coreId);
      // The archived count rides this answer (ADR 0019) but belongs to a
      // different consumer — the Archived tab, which needs it while the active
      // view is showing. Park it in its own bucket rather than widening this
      // list's shape for every reader of it.
      //
      // Not parked by a read whose visit is over. The list itself is safe
      // without this — react-query drops a cancelled fetch's result — but this
      // write is the fetcher's own, so nothing else stops it, and the bucket it
      // writes to has no fetcher to correct it (`useCoreArchivedSessionCount` is
      // `enabled: false`). Left ungated, an abandoned read landing after the
      // read that replaced it would leave the Archived tab labelled from rows
      // the list no longer holds.
      if (!readIsStale()) {
        client.setQueryData(queryKeys.coreArchivedSessionCount(coreId), archivedCount);
      }
      return sessions.map(remoteSessionFromSnapshot);
    },
  });

/**
 * A Core's archived Sessions — the Archived view's own read path (ADR 0019).
 * Fetched over the dedicated `archivedSessionRowsList` frame, and only while
 * `enabled` (the view being open), so opening a Core pulls no archived rows.
 */
export const archivedSessionsQueryOptions = (coreId: string, opts: { enabled: boolean }) =>
  queryOptions({
    ...CORE_SCOPED_FRESHNESS,
    queryKey: queryKeys.coreArchivedSessions(coreId),
    queryFn: async () => {
      const bridge = getPanelBridge();
      if (!bridge) return [];
      const sessions = await bridge.listArchivedSessions(coreId);
      return sessions.map(remoteSessionFromSnapshot);
    },
    enabled: opts.enabled,
  });

export const settingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings,
    queryFn: async () => {
      const settings = await api.getSettings();
      // Mirror the default runtime into a module cache so commandForSession can append
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
 * Tie one Core-scoped query to the Core that is actually on screen.
 *
 * Reading an uncached Core is slower than clicking away from it. During
 * A then B then A, B's session reads are still in flight when the URL is
 * already back on A, and what they were going to materialize — B's sessions,
 * B's archived count, the focus that follows them — would land on A's URL
 * (issue 381).
 *
 * While the query is being read by something on screen the scope is retained,
 * so a cold Core the operator stays on loads exactly as before — the 30s
 * `staleTime` is untouched, and nothing here makes a read start any later.
 * When the last reader of a scope goes away, an *in-flight* fetch for it is
 * cancelled: react-query reverts the query to the state it had before the
 * fetch, and the answer, whenever it turns up, is discarded rather than
 * written. Coming back to that Core later simply reads it again.
 *
 * Only a fetch in flight is cancelled. A settled query keeps its data, so
 * leaving a Core never throws away rows the operator would see on return.
 *
 * Cancelling is not the whole guard, because a cancelled fetch's promise still
 * resolves — the panel link has nothing to abort — and its fetcher runs to the
 * end. Anything a fetcher writes for itself is guarded by
 * {@link watchCoreScope} instead; see `sessionsQueryOptions`.
 */
function useScopedToVisibleCore(queryKey: readonly unknown[], coreId: string): void {
  const queryClient = useQueryClient();
  // The key is rebuilt every render; its hash is what actually changes.
  const keyHash = hashKey(queryKey);
  useEffect(() => {
    // `useSessions("")` is how the grid's hidden-session bar asks before it has a
    // scope at all — no Core, nothing to keep on screen.
    if (!coreId) return;
    return retainCoreScope(coreId, {
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
  }, [queryClient, coreId, keyHash]);
}

// Tasks move on the server (the dispatcher claims, a result file finishes), and
// nothing pushes that to the browser, so the board and an open Task poll.
const TASKS_POLL_MS = 5_000;

export const tasksQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.tasks,
    queryFn: async () => (await api.listTasks()).tasks,
    refetchInterval: TASKS_POLL_MS,
    refetchOnMount: "always",
  });

export const taskQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.task(id),
    queryFn: () => api.getTask(id),
    refetchInterval: TASKS_POLL_MS,
    refetchOnMount: "always",
  });

export const coreAgentsQueryOptions = (coreId: string) =>
  queryOptions({
    queryKey: queryKeys.coreAgents(coreId),
    queryFn: async () => (await api.listCoreAgents(coreId)).agents,
    enabled: !!coreId,
  });

/** The Files tab polls S3 (a change on the Core reaches S3 through the sync, so about every ten seconds is as fresh as it gets); a hidden tab does not. */
export const SHARED_FILES_POLL_MS = 10_000;

export const sharedFolderQueryOptions = (coreId: string, path: string) =>
  queryOptions({
    queryKey: queryKeys.sharedFolder(coreId, path),
    queryFn: () => api.listSharedFiles(coreId, path),
    enabled: !!coreId,
    refetchInterval: SHARED_FILES_POLL_MS,
    retry: false,
  });

export const useSharedFolder = (coreId: string, path: string, opts: { enabled?: boolean; poll?: boolean } = {}) =>
  useQuery({
    ...sharedFolderQueryOptions(coreId, path),
    enabled: !!coreId && opts.enabled !== false,
    ...(opts.poll === false ? { refetchInterval: false as const } : {}),
  });

export const useSharedFileDetails = (coreId: string, path: string | null, opts: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: queryKeys.sharedFileDetails(coreId, path ?? ""),
    queryFn: () => api.getSharedFileDetails(coreId, path!),
    enabled: !!coreId && !!path && opts.enabled !== false,
    staleTime: 30_000,
    retry: false,
  });

/** The tree's footer and the "new" badges: one listing of the Core's folder, since the operator's last visit. */
export const useSharedFilesSummary = (coreId: string, since: number) =>
  useQuery({
    queryKey: queryKeys.sharedFilesSummary(coreId, since),
    queryFn: () => api.getSharedFilesSummary(coreId, since),
    enabled: !!coreId,
    refetchInterval: SHARED_FILES_POLL_MS,
    retry: false,
  });

export const useSharedFilesSearch = (coreId: string, query: string) =>
  useQuery({
    queryKey: queryKeys.sharedFilesSearch(coreId, query),
    queryFn: () => api.searchSharedFiles(coreId, query),
    enabled: !!coreId && query.trim().length > 0,
    retry: false,
  });

export const useTasks = () => useQuery(tasksQueryOptions());
export const useTask = (id: string) => useQuery(taskQueryOptions(id));
export const useCoreAgents = (coreId: string) => useQuery(coreAgentsQueryOptions(coreId));

export const useSessions = (coreId: string) => {
  const options = sessionsQueryOptions(coreId);
  useScopedToVisibleCore(options.queryKey, coreId);
  return useQuery(options);
};
/** A Core's archived Sessions, read only while `enabled` (the Archived view is open). */
export const useArchivedSessions = (coreId: string, opts: { enabled: boolean }) =>
  useQuery(archivedSessionsQueryOptions(coreId, { enabled: !!coreId && opts.enabled }));

/**
 * How many archived Sessions a Core holds.
 *
 * The number arrives on the `sessionRowsList` answer (ADR 0019) and is parked in
 * this bucket by {@link sessionsQueryOptions}' fetcher, because its consumers —
 * the Archived tab's gating and label, the "View archived" tooltip, the
 * auto-exit effect, the delete-confirm dialog — all read it while the *active*
 * view is showing. So this query never fetches: `enabled: false` leaves the
 * bucket to its writer, and the subscription is what re-renders the tab when
 * the number moves. Zero until the first session list lands.
 */
export const useCoreArchivedSessionCount = (coreId: string): number =>
  useQuery({
    queryKey: queryKeys.coreArchivedSessionCount(coreId),
    queryFn: () => 0,
    enabled: false,
    initialData: 0,
  }).data;

/**
 * Per-row session subscription. Structural sharing keeps an unchanged row's
 * identity stable across list refetches, so a consumer (e.g. a terminal pane
 * header) re-renders only when ITS session changes — not on every session:* event.
 *
 * It reads the same bucket {@link useSessions} does; a pane that asked another
 * one read a list that was never going to arrive.
 */
export const useSession = (coreId: string, sessionId: string) => {
  const options = sessionsQueryOptions(coreId);
  // A pane reading one row is a live reader of the same bucket the board
  // reads, so it holds the scope open too — otherwise the board unmounting
  // would cancel a fetch this pane is still waiting on.
  useScopedToVisibleCore(options.queryKey, coreId);
  return useQuery({
    ...options,
    select: (sessions) => sessions.find((t) => t.id === sessionId),
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
