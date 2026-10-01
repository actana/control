import { describe, expect, it, vi } from "vitest";
import { showRequestedSession } from "../open-requested-session";

const session = { id: "t1" } as never;

function terminals(over: Record<string, unknown> = {}) {
  return {
    activeFor: vi.fn(() => null),
    activeSessionIdFor: vi.fn(() => null),
    rehydrate: vi.fn(),
    toggle: vi.fn(),
    ...over,
  };
}

describe("showRequestedSession", () => {
  it("creates the terminal with the Core id", () => {
    const t = terminals();
    showRequestedSession({ terminals: t, session, coreId: "core-a" });
    expect(t.toggle).toHaveBeenCalledWith("core-a", session);
  });

  it("rehydrates a persisted active Session with the Core id", () => {
    const t = terminals({ activeSessionIdFor: vi.fn(() => "t1") });
    showRequestedSession({ terminals: t, session, coreId: "core-a" });
    expect(t.rehydrate).toHaveBeenCalledWith("core-a", session);
    expect(t.toggle).not.toHaveBeenCalled();
  });

  it("does nothing when the Session is already the open one", () => {
    const t = terminals({ activeFor: vi.fn(() => ({ sessionId: "t1" })) });
    showRequestedSession({ terminals: t, session, coreId: "core-a" });
    expect(t.toggle).not.toHaveBeenCalled();
    expect(t.rehydrate).not.toHaveBeenCalled();
  });
});
