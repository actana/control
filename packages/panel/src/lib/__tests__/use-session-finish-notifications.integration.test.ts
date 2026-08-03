// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import {
  __resetSessionFinishDedupForTests,
  useSessionFinishNotifications,
} from "../use-session-finish-notifications";
import {
  SESSION_FINISH_NOTIFICATIONS_STORAGE_KEY,
  loadSessionFinishNotifications,
  saveAppNotifications,
  type SessionFinishNotification,
} from "../session-notification-store";

const h = vi.hoisted(() => ({
  sseHandler: null as ((e: unknown) => void) | null,
  fleetHandler: null as ((msg: unknown) => void) | null,
  watched: [] as string[],
  settings: {} as Record<string, unknown>,
  navigate: vi.fn((..._args: unknown[]) => undefined),
  mcToastCustom: vi.fn((..._args: unknown[]) => undefined),
  showOsNotification: vi.fn(async (..._args: unknown[]) => undefined),
  playDing: vi.fn((..._args: unknown[]) => undefined),
}));

vi.mock("~/queries", () => ({
  useSettings: () => ({ data: h.settings }),
}));
vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({ cores: [{ id: "core-a", label: "Core A" }] }),
}));
vi.mock("~/lib/use-events", () => ({
  useServerEvents: (handler: (e: unknown) => void) => {
    h.sseHandler = handler;
  },
}));
vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({
    watchCore: (coreId: string) => {
      h.watched.push(coreId);
      return () => {};
    },
    onEvent: (cb: (msg: unknown) => void) => {
      h.fleetHandler = cb;
      return () => {
        h.fleetHandler = null;
      };
    },
  }),
}));
vi.mock("~/lib/mc-toast", () => ({
  mcToastCustom: (...args: unknown[]) => h.mcToastCustom(...args),
  McToastActions: () => null,
  McToastCloseButton: () => null,
}));
vi.mock("~/lib/notification-sound", () => ({
  playNotificationDing: (...args: unknown[]) => h.playDing(...args),
}));
vi.mock("~/lib/os-notifications", () => ({
  showSessionFinishOsNotification: (...args: unknown[]) =>
    h.showOsNotification(...args),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: h.navigate }),
}));

function panelLocalFinishEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "session:finished",
    id: "task-1",
    projectId: "project-1",
    projectName: "Local Project",
    taskTitle: "Local session",
    ...overrides,
  };
}

function remoteFinishFrame(overrides: {
  coreId?: string;
  eventId?: number;
  id?: string;
  projectId?: string;
} = {}) {
  const { coreId = "core-a", eventId = 42, id = "task-42", projectId = "project-9" } =
    overrides;
  return {
    coreId,
    event: {
      eventId,
      ts: 1_700_000_000_000,
      kind: "session:finished",
      ptyId: null,
      taskId: id,
      payload: JSON.stringify({
        id,
        projectId,
            projectName: "Remote Project",
        taskTitle: "Remote session",
      }),
    },
  };
}

/** Render the toast element mcToastCustom captured and return its text. */
function toastText(callIndex = 0): string {
  const renderToast = h.mcToastCustom.mock.calls[callIndex]?.[0] as
    | ((id: string) => React.ReactElement)
    | undefined;
  if (!renderToast) return "";
  const { container, unmount } = render(renderToast("toast-1"));
  const text = container.textContent ?? "";
  unmount();
  return text;
}

describe("useSessionFinishNotifications — integration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetSessionFinishDedupForTests();
    h.settings = {};
    h.sseHandler = null;
    h.fleetHandler = null;
    h.watched = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires exactly one aliased toast and stores one row for a remote finish", () => {
    const hook = renderHook(() => useSessionFinishNotifications());
    act(() => h.fleetHandler?.(remoteFinishFrame()));

    expect(h.mcToastCustom).toHaveBeenCalledTimes(1);
    expect(toastText()).toContain("Session finished — Remote Project on Core A");
    expect(toastText()).toContain("Remote session");

    const stored = loadSessionFinishNotifications();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: "task-42",
      projectId: "project-9",
      coreId: "core-a",
      coreAlias: "Core A",
    });
    expect(hook.result.current.notifications).toHaveLength(1);
    hook.unmount();
  });

  it("drops a replayed (coreId, eventId) frame after a simulated reconnect", () => {
    const hook = renderHook(() => useSessionFinishNotifications());
    act(() => h.fleetHandler?.(remoteFinishFrame()));

    // Simulated reconnect: the dialer re-subscribes and replays the tail.
    act(() => {
      hook.rerender();
      h.fleetHandler?.(remoteFinishFrame());
    });

    expect(h.mcToastCustom).toHaveBeenCalledTimes(1);
    expect(loadSessionFinishNotifications()).toHaveLength(1);
    hook.unmount();
  });

  it("keeps a Panel-local toast title free of the ' on ' suffix", () => {
    const hook = renderHook(() => useSessionFinishNotifications());
    act(() => h.sseHandler?.(panelLocalFinishEvent()));

    expect(h.mcToastCustom).toHaveBeenCalledTimes(1);
    const text = toastText();
    expect(text).toContain("Session finished — Local Project");
    expect(text).not.toContain(" on ");
    expect(loadSessionFinishNotifications()[0]).toMatchObject({
      coreId: null,
      coreAlias: null,
    });
    hook.unmount();
  });

  it("suppresses toasts uniformly when sessionFinishToastEnabled is off, but still stores", () => {
    h.settings = { sessionFinishToastEnabled: false };
    const hook = renderHook(() => useSessionFinishNotifications());
    act(() => h.sseHandler?.(panelLocalFinishEvent()));
    act(() => h.fleetHandler?.(remoteFinishFrame()));

    expect(h.mcToastCustom).not.toHaveBeenCalled();
    expect(loadSessionFinishNotifications()).toHaveLength(2);
    hook.unmount();
  });

  it("sends the OS notification with the alias for a Core and without it for a Panel-local row", () => {
    h.settings = { sessionFinishOsNotificationEnabled: true };
    const hook = renderHook(() => useSessionFinishNotifications());
    act(() => h.fleetHandler?.(remoteFinishFrame()));
    act(() => h.sseHandler?.(panelLocalFinishEvent()));

    expect(h.showOsNotification).toHaveBeenCalledTimes(2);
    expect(h.showOsNotification.mock.calls[0]?.[0]).toMatchObject({
      title: "Session finished — Remote Project on Core A",
      tag: "session-finished-core-a-task-42",
    });
    expect(h.showOsNotification.mock.calls[1]?.[0]).toMatchObject({
      title: "Session finished — Local Project",
      tag: "session-finished-null-task-1",
    });
    hook.unmount();
  });

  it("does not send OS notifications when the setting is off (default)", () => {
    const hook = renderHook(() => useSessionFinishNotifications());
    act(() => h.fleetHandler?.(remoteFinishFrame()));
    expect(h.showOsNotification).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("prunes a Core's rows on its task:deleted without touching Panel-local rows", () => {
    const base: SessionFinishNotification = {
      kind: "session-finished",
      id: "task-1",
      projectId: "project-1",
        projectName: "Project",
      taskTitle: "Session",
      finishedAt: 1,
      coreId: null,
      coreAlias: null,
    };
    saveAppNotifications([base, { ...base, finishedAt: 2, coreId: "core-a" }]);

    const hook = renderHook(() => useSessionFinishNotifications());
    act(() =>
      h.fleetHandler?.({
        coreId: "core-a",
        event: {
          eventId: 43,
          ts: 1_700_000_000_001,
          kind: "task:deleted",
          ptyId: null,
          taskId: "task-1",
          payload: JSON.stringify({ id: "task-1", projectId: "project-1" }),
        },
      }),
    );

    const stored = loadSessionFinishNotifications();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.coreId).toBeNull();
    expect(
      window.localStorage.getItem(SESSION_FINISH_NOTIFICATIONS_STORAGE_KEY),
    ).not.toContain('"core-a"');
    hook.unmount();
  });

  it("watches every registered Core, so a finish on any machine reaches this tab", () => {
    const hook = renderHook(() => useSessionFinishNotifications());
    expect(h.watched).toContain("core-a");
    hook.unmount();
  });

  // Click-through is the browser's now: the notification this tab raised holds
  // the closure, so clicking it focuses the tab (the Notification API's own job)
  // and lands on the Core and Task that finished.
  it("routes a click on a remote notification into the Core-scoped project view", () => {
    h.settings = { sessionFinishOsNotificationEnabled: true };
    const hook = renderHook(() => useSessionFinishNotifications());
    act(() => h.fleetHandler?.(remoteFinishFrame()));

    const onClick = (h.showOsNotification.mock.calls[0]?.[1] as { onClick?: () => void })
      ?.onClick;
    expect(onClick).toBeTypeOf("function");
    act(() => onClick?.());

    expect(h.navigate).toHaveBeenCalledWith({
      to: "/projects/$id",
      params: { id: "project-9" },
      search: { coreId: "core-a" },
    });
    const pending = JSON.parse(
      window.localStorage.getItem("mc:pendingSessionOpen") ?? "null",
    );
    expect(pending).toMatchObject({ taskId: "task-42", coreId: "core-a" });
    hook.unmount();
  });

  it("hands the notification the Session's own tag, title and body", () => {
    h.settings = { sessionFinishOsNotificationEnabled: true };
    const hook = renderHook(() => useSessionFinishNotifications());
    act(() => h.fleetHandler?.(remoteFinishFrame()));

    expect(h.showOsNotification.mock.calls[0]?.[0]).toEqual({
      tag: "session-finished-core-a-task-42",
      title: "Session finished — Remote Project on Core A",
      body: "Remote session",
    });
    hook.unmount();
  });
});
