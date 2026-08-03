// Session-finish notifications, as the browser raises them.
//
// The Panel is a web page now, so "OS notification" means the Notification API
// from whichever tab is open — including a backgrounded one, which is the
// point: the operator asked not to have to watch the grid. Permission is asked
// for from the settings toggle and nowhere else; a page that prompts on load
// gets denied once and stays denied.
//
// Everything here degrades to `false` rather than throwing. A denied or
// undecided permission, a browser without the API, a constructor that refuses
// — all of them mean the same thing to the caller: no OS notification this
// time, and the in-app toast the hook already showed stands on its own.
//
// Web Push (a notification with no tab open) is phase 2 of ADR 0012 and is
// deliberately absent.

export type OsNotificationPermission = NotificationPermission | "unsupported";

/**
 * What the browser needs to raise one. The Session it belongs to is not in
 * here: the tab that raised the notification holds the closure that opens it,
 * so there is nothing to carry across a process boundary any more.
 */
export type SessionFinishOsNotificationPayload = {
  /** Collapses a repeat of the same Session in the OS's own tray. */
  tag: string;
  title: string;
  body: string;
};

function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function readOsNotificationPermission(): Promise<OsNotificationPermission> {
  if (!supported()) return "unsupported";
  return Notification.permission;
}

/**
 * Ask the browser for permission. Only ever called from the settings toggle —
 * the browser gives a page one good prompt, and spending it on page load
 * wastes it on an operator who hasn't asked for notifications yet.
 */
export async function requestOsNotificationPermission(): Promise<OsNotificationPermission> {
  if (!supported()) return "unsupported";
  return Notification.requestPermission();
}

/**
 * Raise one notification for a finished Session. Clicking it focuses this tab
 * and runs `onClick`, which is what navigates to the Session's Core and Task.
 * The `tag` collapses a repeat of the same Session in the OS's own tray.
 */
export async function showSessionFinishOsNotification(
  payload: SessionFinishOsNotificationPayload,
  opts?: { onClick?: () => void },
): Promise<boolean> {
  if (!supported() || Notification.permission !== "granted") return false;
  try {
    const notification = new Notification(payload.title, {
      body: payload.body,
      tag: payload.tag,
    });
    notification.onclick = () => {
      window.focus();
      opts?.onClick?.();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
