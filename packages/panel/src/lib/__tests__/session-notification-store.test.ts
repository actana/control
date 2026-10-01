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
  readPendingSessionOpen,
  saveSessionFinishNotifications,
  type AppNotification,
  type SessionFinishNotification,
} from "../session-notification-store";

const notifications: SessionFinishNotification[] = [
  {
    kind: "session-finished",
    id: "session-1",
    projectId: "project-1",
    projectName: "Core",
    sessionTitle: "Answer name question",
    finishedAt: 3,
    coreId: null,
    coreAlias: null,
  },
  {
    kind: "session-finished",
    id: "session-2",
    projectId: "project-1",
    projectName: "Core",
    sessionTitle: "Investigate router error",
    finishedAt: 2,
    coreId: null,
    coreAlias: null,
  },
  {
    kind: "session-finished",
    id: "session-1",
    projectId: "project-2",
    projectName: "Academy",
    sessionTitle: "Generate title",
    finishedAt: 1,
    coreId: null,
    coreAlias: null,
  },
];

describe("pruneSessionFinishNotifications", () => {
  it("removes the notification for a deleted session in the matching project", () => {
    const next = pruneSessionFinishNotifications(notifications, {
      type: "session",
      sessionId: "session-1",
      projectId: "project-1",
    });

    expect(next.map((n) => `${n.projectId}:${n.id}`)).toEqual([
      "project-1:session-2",
      "project-2:session-1",
    ]);
  });

  it("removes session notifications by id when the project is unknown", () => {
    const next = pruneSessionFinishNotifications(notifications, {
      type: "session",
      sessionId: "session-1",
    });

    expect(next.map((n) => `${n.projectId}:${n.id}`)).toEqual([
      "project-1:session-2",
    ]);
  });

  it("removes every notification for a deleted project", () => {
    const next = pruneSessionFinishNotifications(notifications, {
      type: "project",
      projectId: "project-1",
    });

    expect(next.map((n) => `${n.projectId}:${n.id}`)).toEqual([
      "project-2:session-1",
    ]);
  });

  it("keeps the same array when nothing matches", () => {
    const next = pruneSessionFinishNotifications(notifications, {
      type: "session",
      sessionId: "missing",
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
        id: `session-${i}`,
        projectId: "project-1",
        projectName: "Core",
        sessionTitle: `Session ${i}`,
        finishedAt: i,
        coreId: null,
        coreAlias: null,
      });
    }

    expect(current).toHaveLength(200);
    // Newest-first, and the 5 oldest (finishedAt 0..4) are dropped.
    expect(current[0]?.id).toBe("session-204");
    const oldest = current[current.length - 1]!;
    expect(oldest.id).toBe("session-5");
    const ids = new Set(current.map((n) => n.id));
    expect(ids.has("session-0")).toBe(false);
    expect(ids.has("session-4")).toBe(false);
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
        .toEqual(["project-1:session-2", "project-2:session-1"]);
      expect(dispatchedEvents.map((event) => event.type)).toEqual([
        "mc:session-notification-open",
        "mc:session-notifications-changed",
      ]);
      expect((dispatchedEvents[0] as CustomEvent).detail).toMatchObject({
        kind: "session-finished",
        projectId: "project-1",
        sessionId: "session-1",
      });
    } finally {
      globalThis.window = previousWindow;
    }
  });
});

describe("opening a 0.5.0 Core's finish (no project id)", () => {
  it("scopes the open request by Core id, which is what the workspace matches on", () => {
    const store = new Map<string, string>();
    const previousWindow = globalThis.window;
    globalThis.window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
      dispatchEvent: () => true,
    } as unknown as Window & typeof globalThis;
    try {
      requestSessionNotificationOpen({
        ...notifications[0]!,
        projectId: "",
        coreId: "core-x",
        coreAlias: null,
      });
      expect(readPendingSessionOpen("core-x")).toMatchObject({
        sessionId: "session-1",
        coreId: "core-x",
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
      id: "session-shared",
      projectId: "project-1",
      projectName: "Core",
      sessionTitle: "Session",
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
      id: "session-1",
      projectId: "project-1",
      projectName: "Core",
      sessionTitle: "Panel-local session",
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
      type: "session",
      sessionId: "session-1",
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
            id: "session-legacy",
            projectId: "project-1",
            projectName: "Core",
            sessionTitle: "Legacy session",
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
      expect(hasAnnouncedFinish("core-a::session-1::42")).toBe(false);

      recordAnnouncedFinish("core-a::session-1::42");

      expect(hasAnnouncedFinish("core-a::session-1::42")).toBe(true);
      // A different finish of the same Session is a different announcement.
      expect(hasAnnouncedFinish("core-a::session-1::77")).toBe(false);

      clearAnnouncedFinishes();

      expect(hasAnnouncedFinish("core-a::session-1::42")).toBe(false);
    });
  });

  it("keeps the newest 500 and drops the oldest, recording each key once", () => {
    withFakeStorage(() => {
      for (let i = 1; i <= 520; i++) recordAnnouncedFinish(`core-a::session-${i}::${i}`);
      recordAnnouncedFinish("core-a::session-520::520");

      const keys = loadAnnouncedFinishes();
      expect(keys).toHaveLength(500);
      expect(keys.filter((key) => key === "core-a::session-520::520")).toHaveLength(1);
      expect(hasAnnouncedFinish("core-a::session-1::1")).toBe(false);
      expect(hasAnnouncedFinish("core-a::session-21::21")).toBe(true);
    });
  });
});
