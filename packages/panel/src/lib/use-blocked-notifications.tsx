import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { mcToastCustom, McToastActions, McToastCloseButton } from "~/lib/mc-toast";
import { useSettings } from "~/queries";
import { CardFrame } from "~/components/ui/CardFrame";
import { Btn } from "~/components/ui/Btn";
import { Icon } from "~/components/ui/Icon";
import { playNotificationDing } from "~/lib/notification-sound";
import { showSessionFinishOsNotification } from "~/lib/os-notifications";
import { requestSessionNotificationOpen } from "~/lib/session-notification-store";
import { createBlockedTracker } from "~/lib/blocked-tracker";
import type { TaskSessionState } from "~/shared/tasks";

// Notifications for blocked work (#954, closes #928). A Session entering `needs-input`, and a Task whose
// `sessionState` becomes `needs-input` or `idle-no-result`, raise one toast / OS notification / ding, worded and
// iconed differently from "Session finished". They ride the same permission and toggles (ADR 0008); the
// "blocked" toggle (`sessionBlockedNotificationEnabled`, default on) switches this kind off as a whole.
// The inputs are the data the Panel already polls: no new socket.

export type BlockedSession = { coreId: string; coreLabel: string | null; sessionId: string; title: string; status: string };
export type BlockedTask = { id: string; title: string; sessionState: TaskSessionState | null };

/** A Task's latest auto-retry event (#958): `notice.id` changes with every retry, give-up and breaker trip. `group` is the column it was read from. */
export type BlockedRetryTask = {
  id: string;
  title: string;
  group: string;
  notice: { id: number; kind: "retry" | "gave-up" | "paused"; text: string } | null;
};

/** The columns whose Tasks carry an auto-retry notice: the ones a retry moves a Task through. */
export const RETRY_NOTICE_COLUMNS = ["assigned", "in_progress", "finished"] as const;

const RETRY_TITLE: Record<string, string> = {
  retry: "Task is being retried",
  "gave-up": "Task gave up retrying",
  paused: "Auto-retry paused on a Core",
};

const SESSION_TRIGGERS: ReadonlySet<string> = new Set(["needs-input"]);
const TASK_TRIGGERS: ReadonlySet<string> = new Set(["needs-input", "idle-no-result"]);

const TASK_TITLE: Record<string, string> = {
  "needs-input": "Task needs input",
  "idle-no-result": "Task is idle without a result",
};

const sessionKey = (s: { coreId: string; sessionId: string }) => `${s.coreId}::${s.sessionId}`;

export function useBlockedNotifications({
  sessions,
  loadedCores,
  tasks,
  retryTasks = null,
  viewed,
}: {
  sessions: readonly BlockedSession[];
  /** The Cores whose Session list has answered, empty ones included: each is a baseline. A Core not named learns its baseline from its first Session. */
  loadedCores?: readonly string[];
  /** `null` until the Task list has loaded: it is no baseline, and nothing is tracked. A loaded empty list is one. */
  tasks: readonly BlockedTask[] | null;
  /** The Tasks of the columns a retry moves through, with their auto-retry notice (#958); `null` until all have loaded (no baseline). */
  retryTasks?: readonly BlockedRetryTask[] | null;
  /** The Session the Operator is looking at now, if any: it does not notify. */
  viewed: { coreId: string; sessionId: string } | null;
}) {
  const router = useRouter();
  const { data: settings } = useSettings();
  const enabled = settings?.sessionBlockedNotificationEnabled ?? true;
  const toastEnabled = settings?.sessionFinishToastEnabled ?? true;
  const osEnabled = settings?.sessionFinishOsNotificationEnabled ?? false;
  const soundEnabled = settings?.notificationSoundEnabled ?? true;
  const sessionTracker = useRef(createBlockedTracker(SESSION_TRIGGERS));
  const taskTracker = useRef(createBlockedTracker(TASK_TRIGGERS));
  // Any notice id is a trigger: the state is the id, so a new id is a new event.
  const retryTracker = useRef(createBlockedTracker({ has: () => true }));
  // Read at fire time, so a changed toggle or a new view never re-runs the tracking.
  const live = useRef({ enabled, toastEnabled, osEnabled, soundEnabled, viewed });
  live.current = { enabled, toastEnabled, osEnabled, soundEnabled, viewed };

  const announce = (n: { tag: string; title: string; body: string; open: () => void }) => {
    const { toastEnabled, osEnabled, soundEnabled } = live.current;
    playNotificationDing(soundEnabled);
    if (toastEnabled) {
      mcToastCustom(
        (t) => (
          <CardFrame style={{ position: "relative", minWidth: 360, maxWidth: 460, padding: "14px 16px", display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 999,
                background: "color-mix(in srgb, var(--warning) 22%, transparent)",
                border: "1px solid color-mix(in srgb, var(--warning) 50%, transparent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--warning)",
                flexShrink: 0,
              }}
            >
              <Icon name="bell" size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: "var(--warning)", fontWeight: 700, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.title}</div>
              <div style={{ color: "var(--text-faint, rgba(255,255,255,0.6))", fontSize: 12, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.body}</div>
            </div>
            <McToastActions>
              <Btn
                variant="primary"
                size="sm"
                onClick={() => {
                  n.open();
                  toast.dismiss(t);
                }}
              >
                Open
              </Btn>
              <McToastCloseButton toastId={t} />
            </McToastActions>
          </CardFrame>
        ),
        { duration: 8000 },
      );
    }
    if (osEnabled) void showSessionFinishOsNotification({ tag: n.tag, title: n.title, body: n.body }, { onClick: n.open });
  };

  useEffect(() => {
    const cur = live.current;
    const v = cur.viewed;
    const fired = sessionTracker.current.update(
      sessions.map((s) => ({
        key: sessionKey(s),
        group: s.coreId,
        state: s.status,
        suppressed: v !== null && v.coreId === s.coreId && v.sessionId === s.sessionId,
      })),
      { loadedGroups: loadedCores },
    );
    if (!cur.enabled) return;
    for (const key of fired) {
      const s = sessions.find((x) => sessionKey(x) === key);
      if (!s) continue;
      announce({
        tag: `session-needs-input-${key}`,
        title: `Session needs input on ${s.coreLabel ?? s.coreId}`,
        body: s.title,
        open: () => {
          requestSessionNotificationOpen({ kind: "session-finished", id: s.sessionId, sessionTitle: s.title, finishedAt: Date.now(), coreId: s.coreId, coreAlias: s.coreLabel });
          void router.navigate({ to: "/cores/$coreId/workspace", params: { coreId: s.coreId } });
        },
      });
    }
    // Only the polled data re-runs the tracking; toggles and the view are read through `live`.
  }, [sessions, loadedCores]);

  // A Task in view is not suppressed: the list DTO carries no Session id to match against the one on screen.
  useEffect(() => {
    if (tasks === null) return;
    const fired = taskTracker.current.update(
      tasks.map((t) => ({ key: t.id, state: t.sessionState })),
      { loadedGroups: [""] },
    );
    if (!live.current.enabled) return;
    for (const id of fired) {
      const t = tasks.find((x) => x.id === id);
      if (!t || !t.sessionState) continue;
      announce({
        tag: `task-${t.sessionState}-${id}`,
        title: TASK_TITLE[t.sessionState] ?? "Task needs attention",
        body: t.title,
        open: () => void router.navigate({ to: "/tasks", search: { task: id } }),
      });
    }
  }, [tasks]);

  // Every auto-retry, give-up and breaker trip of a Task (#958): the notice id is the state, so each new one fires once.
  // The first loaded list only learns; a Task moving between columns keeps its last id and does not fire again.
  useEffect(() => {
    if (retryTasks === null) return;
    const fired = retryTracker.current.update(
      retryTasks.map((t) => ({ key: t.id, group: t.group, state: t.notice ? String(t.notice.id) : null })),
      { loadedGroups: RETRY_NOTICE_COLUMNS },
    );
    if (!live.current.enabled) return;
    for (const id of fired) {
      const t = retryTasks.find((x) => x.id === id);
      if (!t?.notice) continue;
      announce({
        tag: `task-auto-retry-${id}-${t.notice.id}`,
        title: RETRY_TITLE[t.notice.kind] ?? "Task auto-retry",
        body: `${t.title}: ${t.notice.text}`,
        open: () => void router.navigate({ to: "/tasks", search: { task: id } }),
      });
    }
  }, [retryTasks]);
}
