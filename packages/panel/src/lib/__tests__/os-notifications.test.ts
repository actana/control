// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readOsNotificationPermission,
  requestOsNotificationPermission,
  showSessionFinishOsNotification,
} from "../os-notifications";

// Notifications are the browser's now: one open tab, the Notification API, and
// a click that brings the operator back to the session that finished. There is
// no OS-level path left to ask, and no Web Push (phase 2, ADR 0012) —
// a tab that is closed raises nothing, which is the contract.

type FakeNotificationInstance = {
  title: string;
  options: NotificationOptions | undefined;
  onclick: (() => void) | null;
  closed: boolean;
  close: () => void;
};

const instances: FakeNotificationInstance[] = [];

function installNotification(
  permission: NotificationPermission,
  opts: { throws?: boolean; requestResult?: NotificationPermission } = {},
) {
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => opts.requestResult ?? permission);
    onclick: (() => void) | null = null;
    closed = false;

    constructor(
      public title: string,
      public options?: NotificationOptions,
    ) {
      if (opts.throws) throw new Error("notifications are blocked here");
      instances.push(this as unknown as FakeNotificationInstance);
    }

    close() {
      this.closed = true;
    }
  }
  Object.defineProperty(window, "Notification", {
    configurable: true,
    writable: true,
    value: FakeNotification,
  });
  return FakeNotification;
}

function payload() {
  return {
    tag: "session-finished-core_a-task-1",
    title: "Session finished — Web Panel on mac-mini",
    body: "Port the notifications",
  };
}

beforeEach(() => {
  instances.length = 0;
});

afterEach(() => {
  Reflect.deleteProperty(window, "Notification");
  vi.restoreAllMocks();
});

describe("readOsNotificationPermission", () => {
  it("reports the browser's current permission", async () => {
    installNotification("granted");
    await expect(readOsNotificationPermission()).resolves.toBe("granted");
  });

  it("reports unsupported where the browser has no Notification API", async () => {
    await expect(readOsNotificationPermission()).resolves.toBe("unsupported");
  });
});

describe("requestOsNotificationPermission", () => {
  it("asks the browser and returns its answer", async () => {
    const Fake = installNotification("default", { requestResult: "granted" });
    await expect(requestOsNotificationPermission()).resolves.toBe("granted");
    expect(Fake.requestPermission).toHaveBeenCalled();
  });

  it("reports unsupported rather than throwing where there is no API", async () => {
    await expect(requestOsNotificationPermission()).resolves.toBe("unsupported");
  });
});

describe("showSessionFinishOsNotification", () => {
  it("raises a tagged notification when permission is granted", async () => {
    installNotification("granted");
    await expect(showSessionFinishOsNotification(payload())).resolves.toBe(true);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.title).toBe("Session finished — Web Panel on mac-mini");
    expect(instances[0]!.options).toMatchObject({
      body: "Port the notifications",
      tag: "session-finished-core_a-task-1",
    });
  });

  it("focuses this tab and runs the click-through, then closes itself", async () => {
    installNotification("granted");
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    const onClick = vi.fn();

    await showSessionFinishOsNotification(payload(), { onClick });
    instances[0]!.onclick?.();

    expect(focus).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalled();
    expect(instances[0]!.closed).toBe(true);
  });

  it("degrades silently when permission was denied", async () => {
    installNotification("denied");
    await expect(showSessionFinishOsNotification(payload())).resolves.toBe(false);
    expect(instances).toHaveLength(0);
  });

  it("degrades silently when permission was never decided", async () => {
    installNotification("default");
    await expect(showSessionFinishOsNotification(payload())).resolves.toBe(false);
    expect(instances).toHaveLength(0);
  });

  it("degrades silently where the browser has no Notification API", async () => {
    await expect(showSessionFinishOsNotification(payload())).resolves.toBe(false);
  });

  it("degrades silently when the browser refuses to construct one", async () => {
    installNotification("granted", { throws: true });
    await expect(showSessionFinishOsNotification(payload())).resolves.toBe(false);
  });
});
