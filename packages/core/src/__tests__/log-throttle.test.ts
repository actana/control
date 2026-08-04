import { describe, expect, it, vi, beforeEach } from "vitest";

const { errorMock, warnMock, infoMock } = vi.hoisted(() => ({
  errorMock: vi.fn(),
  warnMock: vi.fn(),
  infoMock: vi.fn(),
}));

vi.mock("../log", () => ({
  default: { error: errorMock, warn: warnMock, info: infoMock },
}));

import { makeOpenFailedThrottle } from "../log-throttle";

describe("makeOpenFailedThrottle", () => {
  beforeEach(() => {
    errorMock.mockReset();
    warnMock.mockReset();
    infoMock.mockReset();
  });

  it("emits the first call verbatim", () => {
    let now = 1_000;
    const throttled = makeOpenFailedThrottle("event-log.open-failed", 60_000, "error", () => now);
    throttled({ dbPath: "/x/db", error: "boom" });
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(errorMock).toHaveBeenCalledWith("event-log.open-failed", {
      dbPath: "/x/db",
      error: "boom",
    });
  });

  it("suppresses subsequent calls within the window", () => {
    let now = 1_000;
    const throttled = makeOpenFailedThrottle("event-log.open-failed", 60_000, "error", () => now);
    throttled({ dbPath: "/x/db", error: "boom" });
    now = 2_000;
    throttled({ dbPath: "/x/db", error: "boom" });
    now = 30_000;
    throttled({ dbPath: "/x/db", error: "boom" });
    expect(errorMock).toHaveBeenCalledTimes(1);
  });

  it("flushes a summary when the window elapses, then emits verbatim", () => {
    let now = 1_000;
    const throttled = makeOpenFailedThrottle("event-log.open-failed", 60_000, "error", () => now);
    throttled({ dbPath: "/x/db", error: "boom" });
    now = 2_000;
    throttled({ dbPath: "/x/db", error: "boom" });
    now = 3_000;
    throttled({ dbPath: "/x/db", error: "boom" });
    now = 70_000;
    throttled({ dbPath: "/x/db", error: "boom" });

    expect(errorMock).toHaveBeenCalledTimes(3);
    expect(errorMock).toHaveBeenNthCalledWith(1, "event-log.open-failed", {
      dbPath: "/x/db",
      error: "boom",
    });
    expect(errorMock).toHaveBeenNthCalledWith(2, "event-log.open-failed.summary", {
      count: 2,
      error: "boom",
    });
    expect(errorMock).toHaveBeenNthCalledWith(3, "event-log.open-failed", {
      dbPath: "/x/db",
      error: "boom",
    });
  });

  it("skips the summary when no calls were suppressed", () => {
    let now = 1_000;
    const throttled = makeOpenFailedThrottle("event-log.open-failed", 60_000, "error", () => now);
    throttled({ dbPath: "/x/db", error: "boom" });
    now = 100_000;
    throttled({ dbPath: "/x/db", error: "boom2" });
    expect(errorMock).toHaveBeenCalledTimes(2);
    expect(errorMock).toHaveBeenNthCalledWith(2, "event-log.open-failed", {
      dbPath: "/x/db",
      error: "boom2",
    });
  });
});
