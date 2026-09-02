
export type SessionFinishNotification = {
  kind: "session-finished";
  id: string;
  projectId: string;
  projectName: string;
  taskTitle: string;
  finishedAt: number;
  /** The Core the session ran on; null for a Panel-local row. */
  coreId: string | null;
  coreAlias: string | null;
};

export type AppNotification = SessionFinishNotification;

/** `coreId` omitted prunes across every Core; `coreId: null` prunes only the
 *  Panel's own rows. */
export type SessionNotificationPruneTarget =
  | { type: "task"; taskId: string; projectId?: string; coreId?: string | null }
  | { type: "project"; projectId: string; coreId?: string | null };

export type PendingNotificationOpen = {
  kind: "session-finished";
  projectId: string;
  taskId: string;
  requestedAt: number;
  coreId: string | null;
  coreAlias?: string | null;
};

/** @deprecated Use PendingNotificationOpen */
export type PendingSessionOpen = PendingNotificationOpen;

export const SESSION_NOTIFICATION_OPEN_EVENT = "mc:session-notification-open";
export const SESSION_NOTIFICATIONS_CHANGED_EVENT =
  "mc:session-notifications-changed";

const NOTIFICATIONS_KEY = "mc:sessionFinishNotifications";
// Hard cap on the in-app notification list. Every load/merge/persist path funnels
// through sortNotifications (newest-first), so slicing there keeps the 200 most
// recent and drops the oldest, bounding localStorage growth. Behavior-preserving
// for anyone under the cap.
const MAX_NOTIFICATIONS = 200;
const ANNOUNCED_KEY = "mc:sessionFinishAnnounced";
// How many finish identities this browser remembers having announced. Bounded
// like the list above and for the same reason; oldest drops first.
const MAX_ANNOUNCED_FINISHES = 500;
const PENDING_OPEN_KEY = "mc:pendingSessionOpen";
const PENDING_OPEN_MAX_AGE_MS = 5 * 60_000;

export const SESSION_FINISH_NOTIFICATIONS_STORAGE_KEY = NOTIFICATIONS_KEY;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function notificationTimestamp(notification: AppNotification): number {
  return notification.finishedAt;
}

function toSessionFinishNotification(
  value: Record<string, unknown>,
): SessionFinishNotification | null {
  const id = typeof value.id === "string" ? value.id : "";
  const projectId = typeof value.projectId === "string" ? value.projectId : "";
  const projectName = typeof value.projectName === "string" ? value.projectName : "Project";
  const taskTitle = typeof value.taskTitle === "string" ? value.taskTitle : "Session";
  const finishedAt = typeof value.finishedAt === "number" ? value.finishedAt : 0;
  if (!id || !projectId || !Number.isFinite(finishedAt)) return null;
  const coreId =
    typeof value.coreId === "string" && value.coreId ? value.coreId : null;
  const coreAlias =
    typeof value.coreAlias === "string" && value.coreAlias ? value.coreAlias : null;
  return {
    kind: "session-finished",
    id,
    projectId,
    projectName,
    taskTitle,
    finishedAt,
    coreId,
    coreAlias,
  };
}

function toNotification(value: unknown): AppNotification | null {
  if (!isRecord(value)) return null;
  return toSessionFinishNotification(value);
}

function toPendingOpen(value: unknown): PendingNotificationOpen | null {
  if (!isRecord(value)) return null;
  const projectId = typeof value.projectId === "string" ? value.projectId : "";
  const taskId = typeof value.taskId === "string" ? value.taskId : "";
  const requestedAt = typeof value.requestedAt === "number" ? value.requestedAt : 0;
  if (!projectId || !taskId || !Number.isFinite(requestedAt)) return null;
  const coreId =
    typeof value.coreId === "string" && value.coreId ? value.coreId : null;
  const coreAlias =
    typeof value.coreAlias === "string" && value.coreAlias ? value.coreAlias : null;
  return {
    kind: "session-finished",
    projectId,
    taskId,
    requestedAt,
    coreId,
    coreAlias,
  };
}

function sortNotifications(notifications: AppNotification[]): AppNotification[] {
  return [...notifications]
    .sort((a, b) => notificationTimestamp(b) - notificationTimestamp(a))
    .slice(0, MAX_NOTIFICATIONS);
}

export function loadAppNotifications(): AppNotification[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(NOTIFICATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortNotifications(
      parsed
        .map(toNotification)
        .filter((n): n is AppNotification => !!n),
    );
  } catch {
    return [];
  }
}

/** @deprecated Use loadAppNotifications */
export function loadSessionFinishNotifications(): SessionFinishNotification[] {
  return loadAppNotifications().filter(
    (notification): notification is SessionFinishNotification =>
      notification.kind === "session-finished",
  );
}

export function saveAppNotifications(notifications: AppNotification[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications));
  } catch {
    /* quota or privacy-mode storage */
  }
}

export function publishAppNotifications(notifications: AppNotification[]) {
  saveAppNotifications(notifications);
  dispatchSessionNotificationsChanged(notifications);
}

/**
 * Which finishes this browser has already announced — the toast, the ding, the
 * OS notification — as `(coreId, sessionId, eventId)` keys (issue 388).
 *
 * Separate from the notification list on purpose. That list is what the bell
 * shows and the operator may clear it; this is the record of what was *said*,
 * and clearing the bell does not un-say it. It exists because a tab opening
 * after a Session finished is now replayed that finish, and a second tab
 * opening a minute later must not announce it all over again — the tabs share
 * nothing but this storage.
 *
 * Keys only, so it says nothing about a Session beyond that one was announced.
 */
export function loadAnnouncedFinishes(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ANNOUNCED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string" && !!key);
  } catch {
    return [];
  }
}

/** Whether this browser has already announced that finish. */
export function hasAnnouncedFinish(key: string): boolean {
  return loadAnnouncedFinishes().includes(key);
}

/** Remember that it has. Newest last; the oldest fall off the cap. */
export function recordAnnouncedFinish(key: string) {
  if (typeof window === "undefined" || !key) return;
  const current = loadAnnouncedFinishes().filter((existing) => existing !== key);
  current.push(key);
  try {
    window.localStorage.setItem(
      ANNOUNCED_KEY,
      JSON.stringify(current.slice(-MAX_ANNOUNCED_FINISHES)),
    );
  } catch {
    /* quota or privacy-mode storage */
  }
}

/** Forget every announcement. Used by tests and by a storage reset. */
export function clearAnnouncedFinishes() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ANNOUNCED_KEY);
  } catch {
    /* quota or privacy-mode storage */
  }
}

export function subscribeAppNotifications(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const onChanged = () => {
    onStoreChange();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === NOTIFICATIONS_KEY) onChanged();
  };
  window.addEventListener(SESSION_NOTIFICATIONS_CHANGED_EVENT, onChanged);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SESSION_NOTIFICATIONS_CHANGED_EVENT, onChanged);
    window.removeEventListener("storage", onStorage);
  };
}

/** @deprecated Use saveAppNotifications */
export function saveSessionFinishNotifications(
  notifications: SessionFinishNotification[],
) {
  const others = loadAppNotifications().filter((n) => n.kind !== "session-finished");
  saveAppNotifications(sortNotifications([...others, ...notifications]));
}

export function clearAppNotifications() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(NOTIFICATIONS_KEY);
    dispatchSessionNotificationsChanged([]);
  } catch {
    /* quota or privacy-mode storage */
  }
}

/** @deprecated Use clearAppNotifications */
export function clearSessionFinishNotifications() {
  clearAppNotifications();
}

export function mergeSessionFinishNotification(
  current: AppNotification[],
  next: SessionFinishNotification,
): AppNotification[] {
  return sortNotifications([
    next,
    ...current.filter(
      (n) =>
        !(
          n.kind === "session-finished" &&
          n.coreId === next.coreId &&
          n.id === next.id &&
          n.projectId === next.projectId
        ),
    ),
  ]);
}

function notificationMatchesPruneTarget(
  notification: AppNotification,
  target: SessionNotificationPruneTarget,
): boolean {
  if (target.type === "task") {
    return (
      notification.kind === "session-finished" &&
      notification.id === target.taskId &&
      (!target.projectId || notification.projectId === target.projectId) &&
      (target.coreId === undefined || notification.coreId === target.coreId)
    );
  }
  return (
    notification.projectId === target.projectId &&
    (target.coreId === undefined || notification.coreId === target.coreId)
  );
}

export function pruneAppNotifications(
  current: AppNotification[],
  target: SessionNotificationPruneTarget,
): AppNotification[] {
  const next = current.filter(
    (notification) => !notificationMatchesPruneTarget(notification, target),
  );
  return next.length === current.length ? current : next;
}

/** @deprecated Use pruneAppNotifications */
export function pruneSessionFinishNotifications(
  current: AppNotification[],
  target: SessionNotificationPruneTarget,
): AppNotification[] {
  return pruneAppNotifications(current, target);
}

function notificationPruneTarget(
  notification: AppNotification,
): SessionNotificationPruneTarget {
  return {
    type: "task",
    taskId: notification.id,
    projectId: notification.projectId,
  };
}

export function pruneAppNotification(
  current: AppNotification[],
  notification: AppNotification,
): AppNotification[] {
  return pruneAppNotifications(current, notificationPruneTarget(notification));
}

/** @deprecated Use pruneAppNotification */
export function pruneSessionFinishNotification(
  current: AppNotification[],
  notification: SessionFinishNotification,
): AppNotification[] {
  return pruneAppNotification(current, notification);
}

function dispatchSessionNotificationsChanged(notifications: AppNotification[]) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(SESSION_NOTIFICATIONS_CHANGED_EVENT, {
      detail: { notifications },
    }),
  );
}

export function pruneStoredAppNotifications(
  target: SessionNotificationPruneTarget,
): AppNotification[] {
  const current = loadAppNotifications();
  const next = pruneAppNotifications(current, target);
  if (next !== current) {
    publishAppNotifications(next);
  }
  return next;
}

/** @deprecated Use pruneStoredAppNotifications */
export function pruneStoredSessionFinishNotifications(
  target: SessionNotificationPruneTarget,
): AppNotification[] {
  return pruneStoredAppNotifications(target);
}

export function clearAppNotification(notification: AppNotification): AppNotification[] {
  const next = pruneAppNotification(loadAppNotifications(), notification);
  publishAppNotifications(next);
  return next;
}

export function pruneStoredAppNotification(
  notification: AppNotification,
): AppNotification[] {
  return pruneStoredAppNotifications(notificationPruneTarget(notification));
}

/** @deprecated Use pruneStoredAppNotification */
export function pruneStoredSessionFinishNotification(
  notification: SessionFinishNotification,
): AppNotification[] {
  return pruneStoredAppNotification(notification);
}

function writePendingOpen(request: PendingNotificationOpen) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PENDING_OPEN_KEY,
      JSON.stringify(request),
    );
  } catch {
    /* quota or privacy-mode storage */
  }
}

function dispatchPendingOpen(request: PendingNotificationOpen) {
  window.dispatchEvent(
    new CustomEvent<PendingNotificationOpen>(SESSION_NOTIFICATION_OPEN_EVENT, {
      detail: request,
    }),
  );
}

export function requestSessionNotificationOpen(
  notification: SessionFinishNotification,
) {
  if (typeof window === "undefined") return;
  const request: PendingNotificationOpen = {
    kind: "session-finished",
    projectId: notification.projectId,
    taskId: notification.id,
    requestedAt: Date.now(),
    coreId: notification.coreId,
    coreAlias: notification.coreAlias,
  };
  writePendingOpen(request);
  dispatchPendingOpen(request);
  pruneStoredAppNotification(notification);
}

function readPendingOpenFromKey(
  key: string,
): PendingNotificationOpen | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const request = toPendingOpen(JSON.parse(raw));
    if (!request) return null;
    if (Date.now() - request.requestedAt > PENDING_OPEN_MAX_AGE_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    return request;
  } catch {
    return null;
  }
}

export function readPendingSessionOpen(
  projectId: string,
): PendingNotificationOpen | null {
  const request = readPendingOpenFromKey(PENDING_OPEN_KEY);
  if (!request) return null;
  return request.projectId === projectId ? request : null;
}

export function clearPendingNotificationOpen(request: PendingNotificationOpen) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(PENDING_OPEN_KEY);
    const current = raw ? toPendingOpen(JSON.parse(raw)) : null;
    if (
      current &&
      current.projectId === request.projectId &&
      current.taskId === request.taskId &&
      current.requestedAt === request.requestedAt
    ) {
      window.localStorage.removeItem(PENDING_OPEN_KEY);
    }
  } catch {
    /* ignore malformed storage */
  }
}

/** @deprecated Use clearPendingNotificationOpen */
export function clearPendingSessionOpen(request: PendingNotificationOpen) {
  clearPendingNotificationOpen(request);
}
