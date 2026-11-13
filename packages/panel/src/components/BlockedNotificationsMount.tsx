import { useMemo } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useFleet } from "~/lib/fleet-context";
import { useTerminals } from "~/lib/terminal-store";
import { useTasksColumn } from "~/queries";
import { RETRY_NOTICE_COLUMNS, useBlockedNotifications, type BlockedRetryTask } from "~/lib/use-blocked-notifications";

/**
 * Feeds the blocked-work notifications (#954) from data the Panel already polls: the fleet's Session rows and the
 * running, assigned and finished Tasks' first pages (the board's own poll). It renders nothing.
 */
export function BlockedNotificationsMount() {
  const { fleet, answeredCoreIds: loadedCores } = useFleet();
  const running = useTasksColumn("in_progress", null);
  const assigned = useTasksColumn("assigned", null);
  const finished = useTasksColumn("finished", null);
  const { activeSessionIdFor } = useTerminals();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const sessions = useMemo(
    () => fleet.rows.map((r) => ({ coreId: r.coreId, coreLabel: r.coreLabel, sessionId: r.sessionId, title: r.title, status: r.status })),
    [fleet.rows],
  );
  // `null` until the running Tasks have loaded: an empty list that is still loading is not a baseline.
  const tasks = useMemo(
    () => (running.data ? running.data.pages.flatMap((p) => p.tasks).map((t) => ({ id: t.id, title: t.title, sessionState: t.sessionState })) : null),
    [running.data],
  );
  // Auto-retry events (#958): a retried Task is `assigned`, then `in_progress`, and ends `failed` (in the finished column).
  // `null` until all three have loaded, so a column that answers late is not news.
  const retryTasks = useMemo<BlockedRetryTask[] | null>(() => {
    const columns = { assigned, in_progress: running, finished } as const;
    if (RETRY_NOTICE_COLUMNS.some((c) => !columns[c].data)) return null;
    return RETRY_NOTICE_COLUMNS.flatMap((group) =>
      columns[group].data!.pages.flatMap((p) => p.tasks).map((t) => ({ id: t.id, title: t.title, group, notice: t.autoRetry?.notice ?? null })),
    );
  }, [assigned.data, running.data, finished.data]);
  // In view = the workspace of that Core is open, that Session is its active one, and the tab is visible.
  const match = /^\/cores\/([^/]+)\/workspace/.exec(path);
  const coreId = match ? decodeURIComponent(match[1]!) : null;
  const sessionId = coreId ? activeSessionIdFor(coreId) : null;
  const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
  const viewed = coreId && sessionId && visible ? { coreId, sessionId } : null;
  useBlockedNotifications({ sessions, loadedCores, tasks, retryTasks, viewed });
  return null;
}
