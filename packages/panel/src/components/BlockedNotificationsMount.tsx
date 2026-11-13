import { useMemo } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useFleet } from "~/lib/fleet-context";
import { useTerminals } from "~/lib/terminal-store";
import { useTasksColumn } from "~/queries";
import { useBlockedNotifications } from "~/lib/use-blocked-notifications";

/**
 * Feeds the blocked-work notifications (#954) from data the Panel already polls: the fleet's Session rows and the
 * running Tasks' first page (the board's own poll). It renders nothing.
 */
export function BlockedNotificationsMount() {
  const { fleet, answeredCoreIds: loadedCores } = useFleet();
  const running = useTasksColumn("in_progress", null);
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
  // In view = the workspace of that Core is open, that Session is its active one, and the tab is visible.
  const match = /^\/cores\/([^/]+)\/workspace/.exec(path);
  const coreId = match ? decodeURIComponent(match[1]!) : null;
  const sessionId = coreId ? activeSessionIdFor(coreId) : null;
  const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
  const viewed = coreId && sessionId && visible ? { coreId, sessionId } : null;
  useBlockedNotifications({ sessions, loadedCores, tasks, viewed });
  return null;
}
