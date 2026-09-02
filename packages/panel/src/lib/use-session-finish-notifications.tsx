import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { mcToastCustom, McToastActions, McToastCloseButton } from "~/lib/mc-toast";
import { useSettings } from "~/queries";
import { useCores } from "~/lib/use-fleet";
import { getPanelBridge } from "~/lib/panel-bridge";
import { useServerEvents, type ServerEvent } from "~/lib/use-events";
import { CardFrame } from "~/components/ui/CardFrame";
import { Btn } from "~/components/ui/Btn";
import { Icon } from "~/components/ui/Icon";
import { playNotificationDing } from "~/lib/notification-sound";
import { showSessionFinishOsNotification } from "~/lib/os-notifications";
import {
  SESSION_FINISH_NOTIFICATIONS_STORAGE_KEY,
  SESSION_NOTIFICATIONS_CHANGED_EVENT,
  hasAnnouncedFinish,
  loadAppNotifications,
  mergeSessionFinishNotification,
  pruneAppNotifications,
  publishAppNotifications,
  recordAnnouncedFinish,
  requestSessionNotificationOpen,
  type SessionFinishNotification,
  type SessionNotificationPruneTarget,
} from "~/lib/session-notification-store";
import type { CoreLinkEvent } from "@actana/sdk/core-link-frames";

export type NormalizedFinish = {
  /** The Core the session ran on; null for a row in the Panel's own DB. */
  coreId: string | null;
  coreAlias: string | null;
  eventId: number | null;
  sessionId: string;
  projectId: string;
  projectName: string;
  taskTitle: string;
};

export function dedupKey(n: {
  coreId: string | null;
  sessionId: string;
  eventId: number | null;
}): string {
  return `${n.coreId}::${n.sessionId}::${n.eventId ?? "sse"}`;
}

// Module-scope bounded LRU. Insertion-ordered Set gives us drop-oldest for free
// via delete-then-add. Cap 500 keys; the fast-path (toast/ding/OS) checks this
// before firing so replay tails and duplicate SSE frames don't double-notify.
const DEDUP_CAP = 500;
const seenFinishKeys = new Set<string>();

function markSeen(key: string): boolean {
  if (seenFinishKeys.has(key)) {
    // Touch: move to newest so the LRU eviction below drops truly-oldest.
    seenFinishKeys.delete(key);
    seenFinishKeys.add(key);
    return false;
  }
  seenFinishKeys.add(key);
  while (seenFinishKeys.size > DEDUP_CAP) {
    const oldest = seenFinishKeys.values().next().value;
    if (oldest === undefined) break;
    seenFinishKeys.delete(oldest);
  }
  return true;
}

/**
 * Test hook — do not use in production code. Renderer-only.
 *
 * Clears this tab's half of the dedup only. The other half — what the *browser*
 * has announced (issue 388) — lives in storage on purpose, so calling this and
 * leaving storage alone is exactly the state a newly opened tab is in.
 */
export function __resetSessionFinishDedupForTests() {
  seenFinishKeys.clear();
}

type NormalizeSource = "sse" | "fleet";

export function normalizeSessionFinishedEvent(
  source: NormalizeSource,
  raw: unknown,
  coreAlias: string | null = null,
): NormalizedFinish | null {
  if (source === "sse") {
    const e = raw as Record<string, unknown> | null;
    if (!e || e.type !== "session:finished") return null;
    const sessionId = typeof e.id === "string" ? e.id : "";
    const projectId = typeof e.projectId === "string" ? e.projectId : "";
    if (!sessionId || !projectId) return null;
    const projectName = typeof e.projectName === "string" ? e.projectName : "Project";
    const taskTitle = typeof e.taskTitle === "string" ? e.taskTitle : "Session";
    return {
      coreId: null,
      coreAlias: null,
      eventId: null,
      sessionId,
      projectId,
      projectName,
      taskTitle,
    };
  }
  const msg = raw as { coreId?: unknown; event?: unknown } | null;
  if (!msg || typeof msg.coreId !== "string" || !msg.event) return null;
  const event = msg.event as CoreLinkEvent;
  if (event.kind !== "session:finished") return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(event.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sessionId =
    typeof payload.id === "string" && payload.id
      ? payload.id
      : typeof event.taskId === "string"
        ? event.taskId
        : "";
  const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
  if (!sessionId || !projectId) return null;
  const projectName =
    typeof payload.projectName === "string" ? payload.projectName : "Project";
  const taskTitle =
    typeof payload.taskTitle === "string" ? payload.taskTitle : "Session";
  return {
    coreId: msg.coreId,
    coreAlias,
    eventId: typeof event.eventId === "number" ? event.eventId : null,
    sessionId,
    projectId,
    projectName,
    taskTitle,
  };
}

/**
 * How a finish reached this tab. `live` is the event happening; `replay` is the
 * service handing a tab that just opened a finish it was not there for — the
 * fix for a new tab getting no notice at all (issue 388).
 */
type FinishDelivery = "live" | "replay";

type RemoteDeletionKind = "task" | "project";

function classifyRemoteDeletion(kind: string): RemoteDeletionKind | null {
  if (kind === "task:deleted") return "task";
  if (kind === "project:deleted") return "project";
  return null;
}

export function useSessionFinishNotifications() {
  const router = useRouter();
  const { data: settings } = useSettings();
  const toastEnabled = settings?.sessionFinishToastEnabled ?? true;
  const osEnabled = settings?.sessionFinishOsNotificationEnabled ?? false;
  const soundEnabled = settings?.notificationSoundEnabled ?? true;
  const bridge = getPanelBridge();
  const { cores } = useCores();
  const coreAliasById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of cores) map.set(c.id, c.label);
    return map;
  }, [cores]);
  // Which Cores exist — the only thing about the registry a subscription cares
  // about. The poll behind `useCores` hands back a fresh array every tick.
  const coreIds = useMemo(() => cores.map((c) => c.id).join(","), [cores]);
  const coresRef = useRef(cores);
  coresRef.current = cores;
  const coreAliasByIdRef = useRef(coreAliasById);
  coreAliasByIdRef.current = coreAliasById;
  const [notifications, setNotifications] = useState<SessionFinishNotification[]>(() =>
    loadAppNotifications().filter(
      (notification): notification is SessionFinishNotification =>
        notification.kind === "session-finished",
    ),
  );

  const clearNotifications = useCallback(() => {
    const next = loadAppNotifications().filter((n) => n.kind !== "session-finished");
    publishAppNotifications(next);
    setNotifications([]);
  }, []);

  const clearNotification = useCallback((notification: SessionFinishNotification) => {
    setNotifications((prev) => {
      const next = prev.filter(
        (item) =>
          !(
            item.id === notification.id &&
            item.projectId === notification.projectId &&
            item.coreId === notification.coreId
          ),
      );
      if (next.length === prev.length) return prev;
      publishAppNotifications(
        loadAppNotifications().filter(
          (item) =>
            !(
              item.kind === "session-finished" &&
              item.id === notification.id &&
              item.projectId === notification.projectId &&
              item.coreId === notification.coreId
            ),
        ),
      );
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reloadNotifications = () => {
      setNotifications(
        loadAppNotifications().filter(
          (notification): notification is SessionFinishNotification =>
            notification.kind === "session-finished",
        ),
      );
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === SESSION_FINISH_NOTIFICATIONS_STORAGE_KEY) {
        reloadNotifications();
      }
    };
    window.addEventListener(SESSION_NOTIFICATIONS_CHANGED_EVENT, reloadNotifications);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(
        SESSION_NOTIFICATIONS_CHANGED_EVENT,
        reloadNotifications,
      );
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const pruneNotifications = useCallback((target: SessionNotificationPruneTarget) => {
    setNotifications((prev) => {
      const all = loadAppNotifications();
      const nextAll = pruneAppNotifications(all, target);
      if (nextAll === all) return prev;
      publishAppNotifications(nextAll);
      return nextAll.filter(
        (notification): notification is SessionFinishNotification =>
          notification.kind === "session-finished",
      );
    });
  }, []);

  const dispatchNormalizedFinish = useCallback(
    (finish: NormalizedFinish, delivery: FinishDelivery = "live") => {
      const key = dedupKey(finish);
      // A replayed finish is one this tab was not open for (issue 388). It is
      // announced only if nothing in this browser has announced it already:
      // two tabs open when a Session finishes should both say so — that is one
      // event reaching two surfaces — but a tab opened *afterwards* is being
      // told about the same announcement a second time, which is noise.
      if (delivery === "replay" && hasAnnouncedFinish(key)) return;
      if (!markSeen(key)) return;
      // Remembered across tabs only for a finish the Core numbered. An SSE
      // finish has no eventId, so its key cannot tell one finish of a Session
      // from the next one, and a durable record of it would silence a real
      // second finish forever.
      if (finish.eventId !== null) recordAnnouncedFinish(key);

      const notification: SessionFinishNotification = {
        kind: "session-finished",
        id: finish.sessionId,
        projectId: finish.projectId,
        projectName: finish.projectName,
        taskTitle: finish.taskTitle,
        finishedAt: Date.now(),
        coreId: finish.coreId,
        coreAlias: finish.coreAlias,
      };

      setNotifications((prev) => {
        const all = loadAppNotifications();
        const nextAll = mergeSessionFinishNotification(all, notification);
        publishAppNotifications(nextAll);
        return nextAll.filter(
          (item): item is SessionFinishNotification => item.kind === "session-finished",
        );
      });

      playNotificationDing(soundEnabled);

      const isRemote = !!finish.coreId;
      const aliasSuffix = isRemote
        ? ` on ${finish.coreAlias && finish.coreAlias.length > 0 ? finish.coreAlias : finish.coreId}`
        : "";
      const toastTitle = `Session finished — ${finish.projectName}${aliasSuffix}`;

      const goToProject = () => {
        requestSessionNotificationOpen(notification);
        // Narrows on `finish.coreId` rather than the equivalent `isRemote`, so
        // the `string | null` loses its `null` for the search param's `string`.
        const search = finish.coreId ? { coreId: finish.coreId } : undefined;
        void router.navigate({
          to: "/projects/$id",
          params: { id: finish.projectId },
          search,
        });
      };

      if (toastEnabled) {
        mcToastCustom(
          (t) => (
            <CardFrame
              style={{
                position: "relative",
                minWidth: 360,
                maxWidth: 460,
                padding: "14px 16px",
                display: "flex",
                alignItems: "center",
                gap: 14,
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  background: "color-mix(in srgb, var(--accent) 22%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--accent) 50%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--accent)",
                  flexShrink: 0,
                }}
              >
                <Icon name="check" size={14} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    color: "color-mix(in srgb, var(--accent) 76%, white)",
                    fontWeight: 700,
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {toastTitle}
                </div>
                <div
                  style={{
                    color: "var(--text-faint, rgba(255,255,255,0.6))",
                    fontSize: 12,
                    marginTop: 2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {finish.taskTitle}
                </div>
              </div>
              <McToastActions>
                <Btn
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    goToProject();
                    toast.dismiss(t);
                  }}
                >
                  Open
                </Btn>
                <McToastCloseButton toastId={t} />
              </McToastActions>
            </CardFrame>
          ),
          { duration: 6000 },
        );
      }

      if (osEnabled) {
        void showSessionFinishOsNotification(
          {
            tag: `session-finished-${finish.coreId}-${finish.sessionId}`,
            title: toastTitle,
            body: finish.taskTitle,
          },
          { onClick: goToProject },
        );
      }
    },
    [toastEnabled, osEnabled, soundEnabled, router],
  );

  const handler = useCallback(
    (e: ServerEvent) => {
      if (e.type === "task:deleted") {
        const taskId = String(e.id ?? "");
        const projectId = typeof e.projectId === "string" ? e.projectId : undefined;
        if (taskId) {
          pruneNotifications({
            type: "task",
            taskId,
            projectId,
            coreId: null,
          });
        }
        return;
      }

      if (e.type === "project:deleted") {
        const projectId = String(e.id ?? "");
        if (projectId) {
          pruneNotifications({
            type: "project",
            projectId,
            coreId: null,
          });
        }
        return;
      }

      if (e.type !== "session:finished") return;
      const finish = normalizeSessionFinishedEvent("sse", e);
      if (!finish) return;
      dispatchNormalizedFinish(finish);
    },
    [pruneNotifications, dispatchNormalizedFinish],
  );

  // The Panel's own SSE stream, carrying finishes for rows in the Panel's own
  // DB. It cannot collide with the panel-link source below: its finishes key on
  // `coreId: null`, which is not an id any registered Core can have, so
  // ADR 0008's `(coreId, sessionId, eventId)` dedup separates the two sources
  // by construction. It retires with the Panel-local rows themselves.
  useServerEvents(handler);

  // Every registered Core's event stream, over this tab's one panel link. The
  // hook watches the whole fleet rather than the Core on screen: a Session
  // finishing on a machine the operator is not looking at is exactly the one
  // they wanted to be told about (ADR 0008).
  //
  // Keyed on `coreIds`, not the `cores` array: the registry poll replaces that
  // array on every tick, and re-running this effect would tear down and rebuild
  // every watch — dropping subscriptions for as long as it takes to re-send
  // them. Aliases are read through a ref for the same reason: a renamed Core
  // should change the next toast's wording, not the subscriptions.
  useEffect(() => {
    if (!bridge) return;
    const releases = coresRef.current.map((core) => bridge.watchCore(core.id));
    const off = bridge.onEvent((msg) => {
      const kind = msg.event?.kind;
      if (!kind) return;
      const deletion = classifyRemoteDeletion(kind);
      if (deletion) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(msg.event.payload) as Record<string, unknown>;
        } catch {
          return;
        }
        if (deletion === "task") {
          const taskId =
            typeof payload.id === "string" && payload.id
              ? payload.id
              : typeof msg.event.taskId === "string"
                ? msg.event.taskId
                : "";
          const projectId = typeof payload.projectId === "string" ? payload.projectId : undefined;
          if (taskId) {
            pruneNotifications({ type: "task", taskId, projectId, coreId: msg.coreId });
          }
          return;
        }
        const projectId = typeof payload.id === "string" ? payload.id : "";
        if (projectId) {
          pruneNotifications({ type: "project", projectId, coreId: msg.coreId });
        }
        return;
      }
      if (kind !== "session:finished") return;
      const alias = coreAliasByIdRef.current.get(msg.coreId) ?? null;
      const finish = normalizeSessionFinishedEvent("fleet", msg, alias);
      if (!finish) return;
      dispatchNormalizedFinish(finish, msg.replay === true ? "replay" : "live");
    });
    return () => {
      for (const release of releases) release();
      off();
    };
  }, [bridge, coreIds, pruneNotifications, dispatchNormalizedFinish]);

  return { notifications, clearNotification, clearNotifications };
}
