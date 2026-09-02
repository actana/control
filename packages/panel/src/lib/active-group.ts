import { useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type AppSettings } from "~/lib/api";
import {
  readCachedActiveProjectGroup,
  writeCachedActiveProjectGroup,
} from "~/lib/ui-preference-cache";
import { queryKeys, useGroups, useProjects, useSettings } from "~/queries";
import {
  ACTIVE_GROUP_ALL,
  ACTIVE_GROUP_UNGROUPED,
  type ActiveProjectGroup,
} from "~/shared/ui-preferences";
import type { Group } from "~/db/schema";

export { ACTIVE_GROUP_ALL, ACTIVE_GROUP_UNGROUPED } from "~/shared/ui-preferences";
export type { ActiveProjectGroup } from "~/shared/ui-preferences";

export function isGroupIdActive(active: ActiveProjectGroup): boolean {
  return active !== ACTIVE_GROUP_ALL && active !== ACTIVE_GROUP_UNGROUPED;
}

/** Projects visible under an active group ("all" passes everything through). */
export function filterProjectsByActiveGroup<T extends { groupId: string | null }>(
  projects: T[],
  active: ActiveProjectGroup,
): T[] {
  if (active === ACTIVE_GROUP_ALL) return projects;
  if (active === ACTIVE_GROUP_UNGROUPED) return projects.filter((p) => p.groupId == null);
  return projects.filter((p) => p.groupId === active);
}

/** Display label for the active group ("All projects" / "Ungrouped" / group name). */
export function activeGroupLabel(
  active: ActiveProjectGroup,
  groups: Group[] | undefined,
): string {
  if (active === ACTIVE_GROUP_ALL) return "All projects";
  if (active === ACTIVE_GROUP_UNGROUPED) return "Ungrouped";
  return groups?.find((g) => g.id === active)?.name ?? "All projects";
}

/** The wire shape of an active group: "all" is stored as null. */
function storedActiveGroup(active: ActiveProjectGroup): string | null {
  return active === ACTIVE_GROUP_ALL ? null : active;
}

/** The active group a settings row carries (null reads as "all"). */
function activeGroupOf(settings: Pick<AppSettings, "activeProjectGroup">): ActiveProjectGroup {
  return settings.activeProjectGroup ?? ACTIVE_GROUP_ALL;
}

/**
 * Generation guard over the optimistic active-group write (#384).
 *
 * `setActiveGroup` writes the cache first and PATCHes second, and two PATCHes
 * in flight are not ordered: pick group A then group B and A's answer can land
 * last, carrying the server's *older* `activeProjectGroup` back over B — the
 * rail reverts to an older group under the cursor. So each local write takes
 * the next generation, and a settings answer may only *paint* while its
 * generation is still the newest; an older PATCH resolving late paints nothing.
 *
 * Acknowledgement is tracked separately from painting, because the two ask
 * different questions. "May this answer paint?" is about the newest *write*.
 * "Did the server confirm this group?" is about the newest *answer* — and a
 * superseded PATCH that succeeded did confirm its group, so it must be
 * recorded even though it may not paint. Dropping it is what let a later
 * failure roll the rail back past a group the server was actually holding.
 *
 * `lastAcknowledged()` is where a failed write puts the rail back — never some
 * older group that merely happened to be on screen before the click.
 */
export function createActiveGroupWriteLedger(initial: ActiveProjectGroup = ACTIVE_GROUP_ALL) {
  let latest = 0;
  let inFlight = 0;
  let acknowledged: ActiveProjectGroup = initial;
  /** The write whose answer `acknowledged` came from; 0 for a seed/observe. */
  let acknowledgedGeneration = 0;
  let seeded = false;

  return {
    /** Claim the generation for one local (optimistic) write. */
    beginWrite(): number {
      latest += 1;
      inFlight += 1;
      return latest;
    },
    /** Is `generation` still the newest local write? No side effect. */
    isCurrent(generation: number): boolean {
      return generation === latest;
    },
    /** Settle a write; true only while its answer is still the newest one. */
    settleWrite(generation: number): boolean {
      if (inFlight > 0) inFlight -= 1;
      return generation === latest;
    },
    /**
     * Record the group the server confirmed for one write. Refuses an answer
     * older than the one already recorded, so a late-landing older PATCH
     * cannot un-acknowledge a newer one.
     */
    acknowledge(generation: number, group: ActiveProjectGroup): void {
      if (generation < acknowledgedGeneration) return;
      acknowledgedGeneration = generation;
      acknowledged = group;
      seeded = true;
    },
    /**
     * Adopt a settings answer nobody here asked for (first load, refetch,
     * another window's write arriving on an invalidation) as the acknowledged
     * truth — but only while no local write is in flight, since a cache read
     * during a race is this tab's own optimistic value, not the server's. It
     * outranks every write issued so far, so it takes the newest generation.
     */
    observe(group: ActiveProjectGroup): void {
      if (inFlight > 0) return;
      acknowledgedGeneration = latest;
      acknowledged = group;
      seeded = true;
    },
    /**
     * Best guess at what the server holds before any of it is known — the
     * localStorage seed the rail is already rendering. Once anything real has
     * been acknowledged or observed this is a no-op, and it never overwrites a
     * write in flight.
     */
    seed(group: ActiveProjectGroup): void {
      if (seeded || inFlight > 0) return;
      seeded = true;
      acknowledged = group;
    },
    /** Where a failed write puts the rail back. */
    lastAcknowledged(): ActiveProjectGroup {
      return acknowledged;
    },
  };
}

export type ActiveGroupWriteLedger = ReturnType<typeof createActiveGroupWriteLedger>;

/** One ledger per tab: every `useActiveGroup` caller writes the same setting,
 *  so the generations have to be drawn from a single counter. */
let writes = createActiveGroupWriteLedger();

/** @internal — tests start from a fresh generation counter. */
export function __resetActiveGroupWritesForTests(): void {
  writes = createActiveGroupWriteLedger();
}

/**
 * The globally active project group — the single source of truth is the
 * settings query cache (so every consumer re-renders together); localStorage
 * seeds the value before settings hydrate, and the server `app_settings` KV
 * makes it durable across restarts (same dual-write pattern as
 * `projectsDashboardView`).
 */
export function useActiveGroup(): {
  activeGroup: ActiveProjectGroup;
  setActiveGroup: (next: ActiveProjectGroup) => void;
  groups: Group[];
} {
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const groupsQuery = useGroups();
  const groups = groupsQuery.data;

  const raw: ActiveProjectGroup =
    settings === undefined
      ? (readCachedActiveProjectGroup() ?? ACTIVE_GROUP_ALL)
      : (settings.activeProjectGroup ?? ACTIVE_GROUP_ALL);

  // A stale group id (group deleted, possibly by another window) falls back to
  // "all" — but only once the group list has actually loaded, so a slow fetch
  // doesn't flash the unscoped view.
  const activeGroup = useMemo(() => {
    if (!isGroupIdActive(raw)) return raw;
    if (groups === undefined) return raw;
    return groups.some((g) => g.id === raw) ? raw : ACTIVE_GROUP_ALL;
  }, [raw, groups]);

  // Anything the settings query itself delivers is the server's word, so long
  // as this tab has no write of its own outstanding. Before it hydrates there
  // is no server answer to adopt, so the ledger is seeded with the value the
  // rail is already rendering — otherwise a click made during that window and
  // then failing would roll back to "All projects" rather than to the group
  // the operator was on.
  useEffect(() => {
    if (settings === undefined) writes.seed(raw);
    else writes.observe(activeGroupOf(settings));
  }, [settings, raw]);

  /** The optimistic half: localStorage + settings cache, no request. */
  const showActiveGroup = useCallback(
    (group: ActiveProjectGroup) => {
      writeCachedActiveProjectGroup(group);
      queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) =>
        current ? { ...current, activeProjectGroup: storedActiveGroup(group) } : current,
      );
    },
    [queryClient],
  );

  const setActiveGroup = useCallback(
    (next: ActiveProjectGroup) => {
      const generation = writes.beginWrite();
      void (async () => {
        // The house pattern for an optimistic settings write (see
        // `UsageSettingsPage.tsx` and `ProvidersSettingsPage.tsx`): a settings
        // GET already in flight would answer with the pre-PATCH row and paint
        // it straight over the optimistic write, so it is cancelled first.
        await queryClient.cancelQueries({ queryKey: queryKeys.settings });
        // That await means two rapid clicks resume in an order the click order
        // does not settle, so the optimistic paint takes the same currency
        // guard the answers do.
        if (writes.isCurrent(generation)) showActiveGroup(next);

        let updated: AppSettings | undefined;
        let failure: unknown;
        try {
          updated = await api.updateSettings({ activeProjectGroup: storedActiveGroup(next) });
        } catch (error) {
          failure = error;
        }

        // Exactly once per write, whatever happened above: `settleWrite` is the
        // only thing that decrements the in-flight count, and settling twice
        // would let `observe` adopt this tab's own optimistic value.
        const current = writes.settleWrite(generation);

        if (updated === undefined) {
          console.error("[settings] failed to persist active project group:", failure);
          // A superseded failure leaves the newer selection alone; the newest
          // one goes back to what the server last acknowledged.
          if (current) showActiveGroup(writes.lastAcknowledged());
          return;
        }

        // The server did confirm this group, superseded or not — recording it
        // is what keeps a later failure from rolling back past it.
        writes.acknowledge(generation, activeGroupOf(updated));
        // …but only the newest answer may paint.
        if (!current) return;
        // A merge rather than a full-row replace: `updated` carries every other
        // setting at its pre-PATCH value, so replacing the row would undo a
        // concurrent edit to a neighbouring key (a section collapsed mid-flight
        // popping back open).
        showActiveGroup(activeGroupOf(updated));
      })();
    },
    [queryClient, showActiveGroup],
  );

  // Self-heal persistence when the active group was deleted: the memo above
  // already renders "all"; this clears the stale id so restarts agree.
  useEffect(() => {
    if (!isGroupIdActive(raw)) return;
    if (groups === undefined) return;
    if (!groups.some((g) => g.id === raw)) setActiveGroup(ACTIVE_GROUP_ALL);
  }, [raw, groups, setActiveGroup]);

  return { activeGroup, setActiveGroup, groups: groups ?? [] };
}

/**
 * Projects visible in the active group — the list the dashboard, left
 * rail, and project picker should render.
 */
export function useGroupScopedProjects() {
  const query = useProjects();
  const { activeGroup, setActiveGroup, groups } = useActiveGroup();
  const data = useMemo(() => {
    if (query.data === undefined) return undefined;
    return filterProjectsByActiveGroup(query.data, activeGroup);
  }, [query.data, activeGroup]);
  return { ...query, data, unscopedData: query.data, activeGroup, setActiveGroup, groups };
}
