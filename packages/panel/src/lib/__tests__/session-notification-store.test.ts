import { describe, expect, it } from "vitest";
import {
  clearAnnouncedFinishes,
  clearSessionFinishNotifications,
  hasAnnouncedFinish,
  loadAnnouncedFinishes,
  recordAnnouncedFinish,
  loadSessionFinishNotifications,
  mergeSessionFinishNotification,
  pruneSessionFinishNotifications,
  requestSessionNotificationOpen,
  saveSessionFinishNotifications,
  type AppNotification,
  type SessionFinishNotification,
} from "../session-notification-store";

const notifications: SessionFinishNotification[] = [
  {
    kind: "session-finished",
    id: "task-1",
    projectId: "project-1",
    projectName: "Core",
    taskTitle: "Answer name question",
    finishedAt: 3,
    coreId: null,
    coreAlias: null,
  },
  {
    kind: "session-finished",
    id: "task-2",
    projectId: "project-1",
    projectName: "Core",
    taskTitle: "Investigate router error",
    finishedAt: 2,
    coreId: null,
    coreAlias: null,
  },
  {
    kind: "session-finished",
    id: "task-1",
    projectId: "project-2",
    projectName: "Academy",
    taskTitle: "Generate title",
    finishedAt: 1,
    coreId: null,
    coreAlias: null,
  },
];

describe("pruneSessionFinishNotifications", () => {
  it("removes the notification for a deleted task in the matching project", () => {
    const next = pruneSessionFinishNotifications(notifications, {
      type: "task",
      taskId: "task-1",
      projectId: "project-1",
    });

    expect(next.map((n) => `${n.projectId}:${n.id}`)).toEqual([
      "project-1:task-2",
      "project-2:task-1",
    ]);
  });

  it("removes task notifications by id when the project is unknown", () => {
    const next = pruneSessionFinishNotifications(notifications, {
      type: "task",
      taskId: "task-1",
    });

    expect(next.map((n) => `${n.projectId}:${n.id}`)).toEqual([
      "project-1:task-2",
    ]);
  });

  it("removes every notification for a deleted project", () => {
    const next = pruneSessionFinishNotifications(notifications, {
      type: "project",
      projectId: "project-1",
    });

    expect(next.map((n) => `${n.projectId}:${n.id}`)).toEqual([
      "project-2:task-1",
    ]);
  });

  it("keeps the same array when nothing matches", () => {
    const next = pruneSessionFinishNotifications(notifications, {
      type: "task",
      taskId: "missing",
    });

    expect(next).toBe(notifications);
  });
});

describe("clearSessionFinishNotifications", () => {
  it("clears persisted notifications and emits the notification change event", () => {
    const store = new Map<string, string>();
    const dispatchedEvents: Event[] = [];
    const notification = notifications[0]!;
    const previousWindow = globalThis.window;

    globalThis.window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
      dispatchEvent: (event: Event) => {
        dispatchedEvents.push(event);
        return true;
      },
    } as unknown as Window & typeof globalThis;

    try {
      saveSessionFinishNotifications([notification]);
      expect(loadSessionFinishNotifications()).toEqual([notification]);

      clearSessionFinishNotifications();

      expect(loadSessionFinishNotifications()).toEqual([]);
      expect(dispatchedEvents).toHaveLength(1);
      expect(dispatchedEvents[0]?.type).toBe("mc:session-notifications-changed");
    } finally {
      globalThis.window = previousWindow;
    }
  });
});

describe("notification cap", () => {
  it("keeps only the 200 most-recent notifications, dropping the oldest", () => {
    // 205 notifications with ascending finishedAt (0 = oldest, 204 = newest).
    let current: AppNotification[] = [];
    for (let i = 0; i < 205; i += 1) {
      current = mergeSessionFinishNotification(current, {
        kind: "session-finished",
        id: `task-${i}`,
        projectId: "project-1",
        projectName: "Core",
        taskTitle: `Session ${i}`,
        finishedAt: i,
        coreId: null,
        coreAlias: null,
      });
    }

    expect(current).toHaveLength(200);
    // Newest-first, and the 5 oldest (finishedAt 0..4) are dropped.
    expect(current[0]?.id).toBe("task-204");
    const oldest = current[current.length - 1]!;
    expect(oldest.id).toBe("task-5");
    const ids = new Set(current.map((n) => n.id));
    expect(ids.has("task-0")).toBe(false);
    expect(ids.has("task-4")).toBe(false);
  });
});

describe("requestSessionNotificationOpen", () => {
  it("clears the opened notification and emits open plus change events", () => {
    const store = new Map<string, string>();
    const dispatchedEvents: Event[] = [];
    const notification = notifications[0]!;
    const previousWindow = globalThis.window;

    globalThis.window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
      dispatchEvent: (event: Event) => {
        dispatchedEvents.push(event);
        return true;
      },
    } as unknown as Window & typeof globalThis;

    try {
      saveSessionFinishNotifications(notifications);

      requestSessionNotificationOpen(notification);

      expect(loadSessionFinishNotifications().map((n) => `${n.projectId}:${n.id}`))
        .toEqual(["project-1:task-2", "project-2:task-1"]);
      expect(dispatchedEvents.map((event) => event.type)).toEqual([
        "mc:session-notification-open",
        "mc:session-notifications-changed",
      ]);
      expect((dispatchedEvents[0] as CustomEvent).detail).toMatchObject({
        kind: "session-finished",
        projectId: "project-1",
        taskId: "task-1",
      });
    } finally {
      globalThis.window = previousWindow;
    }
  });
});

describe("coreId dedup + prune", () => {
  it("keeps two rows when the same sessionId lands on two different Cores", () => {
    const base: SessionFinishNotification = {
      kind: "session-finished",
      id: "task-shared",
      projectId: "project-1",
      projectName: "Core",
      taskTitle: "Session",
      finishedAt: 1,
      coreId: null,
      coreAlias: null,
    };
    let current: AppNotification[] = [];
    current = mergeSessionFinishNotification(current, base);
    current = mergeSessionFinishNotification(current, {
      ...base,
      coreId: "core-a",
      coreAlias: "Core A",
      finishedAt: 2,
    });
    expect(current).toHaveLength(2);
    const coreIds = current
      .filter((n): n is SessionFinishNotification => n.kind === "session-finished")
      .map((n) => n.coreId);
    expect(new Set(coreIds)).toEqual(new Set(["core-a", null]));
  });

  it("prune scoped by coreId does not cross-delete other Cores", () => {
    const panelLocal: SessionFinishNotification = {
      kind: "session-finished",
      id: "task-1",
      projectId: "project-1",
      projectName: "Core",
      taskTitle: "Panel-local session",
      finishedAt: 1,
      coreId: null,
      coreAlias: null,
    };
    const remote: SessionFinishNotification = {
      ...panelLocal,
      finishedAt: 2,
      coreId: "core-a",
      coreAlias: "Core A",
    };
    const current: AppNotification[] = [panelLocal, remote];
    const next = pruneSessionFinishNotifications(current, {
      type: "task",
      taskId: "task-1",
      projectId: "project-1",
      coreId: "core-a",
    });
    expect(next).toHaveLength(1);
    const survivor = next[0]!;
    expect(survivor.kind === "session-finished" && survivor.coreId).toBeNull();
  });
});

describe("legacy record backfill", () => {
  it("defaults a missing coreId and coreAlias to null", () => {
    const store = new Map<string, string>();
    const previousWindow = globalThis.window;

    globalThis.window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
      dispatchEvent: () => true,
    } as unknown as Window & typeof globalThis;

    try {
      store.set(
        "mc:sessionFinishNotifications",
        JSON.stringify([
          {
            kind: "session-finished",
            id: "task-legacy",
            projectId: "project-1",
            projectName: "Core",
            taskTitle: "Legacy session",
            finishedAt: 1,
          },
        ]),
      );

      const [loaded] = loadSessionFinishNotifications();
      expect(loaded?.coreId).toBeNull();
      expect(loaded?.coreAlias).toBeNull();
    } finally {
      globalThis.window = previousWindow;
    }
  });
});

describe("announced finishes", () => {
  function withFakeStorage(run: () => void) {
    const store = new Map<string, string>();
    const previousWindow = globalThis.window;
    globalThis.window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
      dispatchEvent: () => true,
    } as unknown as Window & typeof globalThis;
    try {
      run();
    } finally {
      globalThis.window = previousWindow;
    }
  }

  it("remembers a finish it announced, and forgets it on a clear", () => {
    withFakeStorage(() => {
      expect(hasAnnouncedFinish("core-a::task-1::42")).toBe(false);

      recordAnnouncedFinish("core-a::task-1::42");

      expect(hasAnnouncedFinish("core-a::task-1::42")).toBe(true);
      // A different finish of the same Session is a different announcement.
      expect(hasAnnouncedFinish("core-a::task-1::77")).toBe(false);

      clearAnnouncedFinishes();

      expect(hasAnnouncedFinish("core-a::task-1::42")).toBe(false);
    });
  });

  it("keeps the newest 500 and drops the oldest, recording each key once", () => {
    withFakeStorage(() => {
      for (let i = 1; i <= 520; i++) recordAnnouncedFinish(`core-a::task-${i}::${i}`);
      recordAnnouncedFinish("core-a::task-520::520");

      const keys = loadAnnouncedFinishes();
      expect(keys).toHaveLength(500);
      expect(keys.filter((key) => key === "core-a::task-520::520")).toHaveLength(1);
      expect(hasAnnouncedFinish("core-a::task-1::1")).toBe(false);
      expect(hasAnnouncedFinish("core-a::task-21::21")).toBe(true);
    });
  });
});
