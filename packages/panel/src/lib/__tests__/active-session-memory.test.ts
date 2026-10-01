import { describe, expect, it } from "vitest";
import {
  activeSessionWentAway,
  rememberActiveSession,
  type LastActiveSession,
} from "../active-session-memory";
import type { Session } from "~/db/schema";

const SCOPE = "core-a";

function session(id: string, over: Partial<Session> = {}): Session {
  return { id, status: "ready", archived: false, ...over } as Session;
}

describe("rememberActiveSession", () => {
  it("flags an archived Core row, which lives outside the active session list", () => {
    const remembered = rememberActiveSession("t-archived", SCOPE, {
      sessions: [session("t-live")],
      archivedSessions: [session("t-archived", { archived: true })],
      previous: null,
    });

    expect(remembered).toEqual({ coreId: SCOPE, sessionId: "t-archived", archived: true });
  });

  it("flags an archived row that still carries the flag in the session list", () => {
    const remembered = rememberActiveSession("t-archived", SCOPE, {
      sessions: [session("t-live"), session("t-archived", { archived: true })],
      archivedSessions: [],
      previous: null,
    });

    expect(remembered.archived).toBe(true);
  });

  it("leaves a live row unflagged", () => {
    const remembered = rememberActiveSession("t-live", SCOPE, {
      sessions: [session("t-live")],
      archivedSessions: [session("t-archived", { archived: true })],
      previous: null,
    });

    expect(remembered).toEqual({ coreId: SCOPE, sessionId: "t-live", archived: false });
  });

  it("keeps the archived verdict when a refetch drops the row from both lists", () => {
    const previous: LastActiveSession = { coreId: SCOPE, sessionId: "t-archived", archived: true };

    const remembered = rememberActiveSession("t-archived", SCOPE, {
      sessions: [session("t-live")],
      archivedSessions: [],
      previous,
    });

    expect(remembered.archived).toBe(true);
  });

  it("does not carry an archived verdict across a different id or scope", () => {
    const previous: LastActiveSession = { coreId: SCOPE, sessionId: "t-archived", archived: true };

    expect(
      rememberActiveSession("t-live", SCOPE, { sessions: [], archivedSessions: [], previous }).archived,
    ).toBe(false);
    expect(
      rememberActiveSession("t-archived", "core-b", { sessions: [], archivedSessions: [], previous }).archived,
    ).toBe(false);
  });
});

describe("activeSessionWentAway", () => {
  it("reads a deselected archived row as a deselect, not a deletion", () => {
    // Closing the panel on an archived Core session used to force-open an
    // unrelated live one, with no coreId, onto a pane that never spawns.
    const previous: LastActiveSession = { coreId: SCOPE, sessionId: "t-archived", archived: true };

    expect(activeSessionWentAway(previous, SCOPE, [session("t-live")])).toBe(false);
  });

  it("still reads a live row that left the visible list as a deletion", () => {
    const previous: LastActiveSession = { coreId: SCOPE, sessionId: "t-gone", archived: false };

    expect(activeSessionWentAway(previous, SCOPE, [session("t-live")])).toBe(true);
  });

  it("reads a live row still on screen as a deselect", () => {
    const previous: LastActiveSession = { coreId: SCOPE, sessionId: "t-live", archived: false };

    expect(activeSessionWentAway(previous, SCOPE, [session("t-live")])).toBe(false);
  });

  it("says nothing about a memory belonging to another scope", () => {
    const previous: LastActiveSession = { coreId: "core-b", sessionId: "t-gone", archived: false };

    expect(activeSessionWentAway(previous, SCOPE, [session("t-live")])).toBe(false);
  });
});
