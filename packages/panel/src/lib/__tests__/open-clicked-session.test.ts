import { describe, expect, it, vi } from "vitest";
import { openClickedSession } from "../open-clicked-session";
import type { Session } from "~/db/schema";

function session(id: string, over: Partial<Session> = {}): Session {
  return { id, status: "ready", archived: false, ...over } as Session;
}

function openerStub() {
  return { openSession: vi.fn(), focusGridSession: vi.fn() };
}

describe("openClickedSession", () => {
  it("opens an archived Core row, which lives outside the active session list", () => {
    const terminals = openerStub();
    const archived = session("t-archived", { archived: true });

    const opened = openClickedSession("t-archived", {
      sessions: [session("t-active")],
      archivedSessions: [archived],
      coreId: "core-a",
      terminals,
    });

    expect(opened).toBe(true);
    expect(terminals.openSession).toHaveBeenCalledWith("core-a", archived);
    expect(terminals.focusGridSession).toHaveBeenCalledWith("t-archived");
  });

  it("still opens an active row out of the session list, unchanged", () => {
    const terminals = openerStub();
    const active = session("t-active");

    const opened = openClickedSession("t-active", {
      sessions: [active],
      archivedSessions: [session("t-archived", { archived: true })],
      coreId: "core-a",
      terminals,
    });

    expect(opened).toBe(true);
    expect(terminals.openSession).toHaveBeenCalledWith("core-a", active);
    expect(terminals.focusGridSession).toHaveBeenCalledWith("t-active");
  });

  it("prefers the active row when both lists carry the id", () => {
    const terminals = openerStub();
    // Distinct `title`s, and an identity assertion on the argument: two
    // structurally equal fixtures would pass whichever object the helper picked,
    // leaving the sessions-first order the fix depends on untested.
    const fromSessions = session("t1", { archived: true, title: "from sessions" });
    const fromArchived = session("t1", { archived: true, title: "from archivedSessions" });

    openClickedSession("t1", {
      sessions: [fromSessions],
      archivedSessions: [fromArchived],
      coreId: "core-a",
      terminals,
    });

    expect(terminals.openSession.mock.calls[0]?.[1]).toBe(fromSessions);
    expect(terminals.openSession).toHaveBeenCalledWith(
      "core-a",
      expect.objectContaining({ title: "from sessions" }),
    );
  });

  it("opens nothing for an id in neither list", () => {
    const terminals = openerStub();

    const opened = openClickedSession("gone", {
      sessions: [session("t-active")],
      archivedSessions: [session("t-archived", { archived: true })],
      coreId: "core-a",
      terminals,
    });

    expect(opened).toBe(false);
    expect(terminals.openSession).not.toHaveBeenCalled();
    expect(terminals.focusGridSession).not.toHaveBeenCalled();
  });

  it("opens nothing when there is no Core to open it on", () => {
    const terminals = openerStub();

    const opened = openClickedSession("t-archived", {
      sessions: [],
      archivedSessions: [session("t-archived", { archived: true })],
      coreId: null,
      terminals,
    });

    expect(opened).toBe(false);
    expect(terminals.openSession).not.toHaveBeenCalled();
  });
});
