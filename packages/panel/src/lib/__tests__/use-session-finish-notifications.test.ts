import { describe, expect, it } from "vitest";
import {
  dedupKey,
  normalizeSessionFinishedEvent,
} from "../use-session-finish-notifications";

describe("dedupKey", () => {
  it("yields distinct keys for distinct eventIds on the same Core/session", () => {
    const a = dedupKey({ coreId: "core-a", sessionId: "s1", eventId: 5 });
    const b = dedupKey({ coreId: "core-a", sessionId: "s1", eventId: 6 });
    expect(a).not.toBe(b);
  });

  it("yields distinct keys for the same sessionId on different Cores", () => {
    const a = dedupKey({ coreId: "core-a", sessionId: "s1", eventId: 5 });
    const b = dedupKey({ coreId: "core-b", sessionId: "s1", eventId: 5 });
    expect(a).not.toBe(b);
  });

  it("collapses a finish with no eventId against itself", () => {
    const a = dedupKey({ coreId: "core-a", sessionId: "s1", eventId: null });
    const b = dedupKey({ coreId: "core-a", sessionId: "s1", eventId: null });
    expect(a).toBe(b);
  });

  it("tells a finish with no eventId from a numbered one", () => {
    const a = dedupKey({ coreId: "core-a", sessionId: "s1", eventId: null });
    const b = dedupKey({ coreId: "core-a", sessionId: "s1", eventId: 5 });
    expect(a).not.toBe(b);
  });
});

describe("normalizeSessionFinishedEvent", () => {
  it("parses a remote session:finished frame into NormalizedFinish with alias", () => {
    const finish = normalizeSessionFinishedEvent(
      {
        coreId: "core-a",
        event: {
          eventId: 42,
          ts: 1_700_000_000_000,
          kind: "session:finished",
          ptyId: null,
          sessionId: "session-42",
          payload: JSON.stringify({
            id: "session-42",
            sessionTitle: "Ship it",
          }),
        },
      },
      "Core A",
    );
    expect(finish).toEqual({
      coreId: "core-a",
      coreAlias: "Core A",
      eventId: 42,
      // The Core's own `ts`, carried so a replayed finish is dated by when it
      // finished rather than by when a tab was handed it (issue 388).
      finishedAt: 1_700_000_000_000,
      sessionId: "session-42",
      sessionTitle: "Ship it",
    });
  });

  it("falls back to event.sessionId when payload lacks id", () => {
    const finish = normalizeSessionFinishedEvent(
      {
        coreId: "core-a",
        event: {
          eventId: 3,
          ts: 1,
          kind: "session:finished",
          ptyId: null,
          sessionId: "session-fallback",
          payload: JSON.stringify({ sessionTitle: "t" }),
        },
      },
      null,
    );
    expect(finish?.sessionId).toBe("session-fallback");
    expect(finish?.coreAlias).toBeNull();
  });

  it("returns null when payload JSON is malformed", () => {
    const finish = normalizeSessionFinishedEvent({
      coreId: "core-a",
      event: {
        eventId: 1,
        ts: 1,
        kind: "session:finished",
        ptyId: null,
        sessionId: null,
        payload: "not-json",
      },
    });
    expect(finish).toBeNull();
  });

  it("returns null when kind is not session:finished", () => {
    const finish = normalizeSessionFinishedEvent({
      coreId: "core-a",
      event: {
        eventId: 1,
        ts: 1,
        kind: "pty:exit",
        ptyId: "p",
        sessionId: null,
        payload: "{}",
      },
    });
    expect(finish).toBeNull();
  });
});
