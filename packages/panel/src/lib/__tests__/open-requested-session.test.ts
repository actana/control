import { describe, expect, it, vi } from "vitest";
import { showRequestedSession } from "../open-requested-session";

const project = { id: "core-a", path: "" } as never;
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
    showRequestedSession({ terminals: t, scopeKey: "core-a", project, session, coreId: "core-a" });
    expect(t.toggle).toHaveBeenCalledWith(project, session, { coreId: "core-a" });
  });

  it("rehydrates a persisted active Session with the Core id", () => {
    const t = terminals({ activeSessionIdFor: vi.fn(() => "t1") });
    showRequestedSession({ terminals: t, scopeKey: "core-a", project, session, coreId: "core-a" });
    expect(t.rehydrate).toHaveBeenCalledWith(project, session, { coreId: "core-a" });
    expect(t.toggle).not.toHaveBeenCalled();
  });

  it("does nothing when the Session is already the open one", () => {
    const t = terminals({ activeFor: vi.fn(() => ({ sessionId: "t1" })) });
    showRequestedSession({ terminals: t, scopeKey: "core-a", project, session, coreId: "core-a" });
    expect(t.toggle).not.toHaveBeenCalled();
    expect(t.rehydrate).not.toHaveBeenCalled();
  });
});
