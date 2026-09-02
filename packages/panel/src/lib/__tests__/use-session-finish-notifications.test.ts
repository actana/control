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

  it("collapses a Panel-local SSE finish (null eventId) against itself", () => {
    const a = dedupKey({ coreId: null, sessionId: "s1", eventId: null });
    const b = dedupKey({ coreId: null, sessionId: "s1", eventId: null });
    expect(a).toBe(b);
  });
});

describe("normalizeSessionFinishedEvent — SSE", () => {
  it("maps a Panel-local SSE event to a NormalizedFinish", () => {
    const finish = normalizeSessionFinishedEvent("sse", {
      type: "session:finished",
      id: "task-1",
      projectId: "project-1",
      projectName: "Core",
      taskTitle: "Answer question",
    });
    expect(finish).toEqual({
      coreId: null,
      coreAlias: null,
      eventId: null,
      // The Panel's own stream is live by construction: no older time to carry,
      // so the dispatch stamps it with the clock that is right for it.
      finishedAt: null,
      sessionId: "task-1",
      projectId: "project-1",
      projectName: "Core",
      taskTitle: "Answer question",
    });
  });

  it("returns null for non-session:finished SSE events", () => {
    expect(
      normalizeSessionFinishedEvent("sse", { type: "task:updated", id: "x" }),
    ).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(
      normalizeSessionFinishedEvent("sse", {
        type: "session:finished",
        id: "",
        projectId: "p",
      }),
    ).toBeNull();
    expect(
      normalizeSessionFinishedEvent("sse", {
        type: "session:finished",
        id: "t",
        projectId: "",
      }),
    ).toBeNull();
  });
});

describe("normalizeSessionFinishedEvent — fleet", () => {
  it("parses a remote session:finished frame into NormalizedFinish with alias", () => {
    const finish = normalizeSessionFinishedEvent(
      "fleet",
      {
        coreId: "core-a",
        event: {
          eventId: 42,
          ts: 1_700_000_000_000,
          kind: "session:finished",
          ptyId: null,
          taskId: "task-42",
          payload: JSON.stringify({
            id: "task-42",
            projectId: "project-9",
            projectName: "Remote",
            taskTitle: "Ship it",
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
      sessionId: "task-42",
      projectId: "project-9",
      projectName: "Remote",
      taskTitle: "Ship it",
    });
  });

  it("falls back to event.taskId when payload lacks id", () => {
    const finish = normalizeSessionFinishedEvent(
      "fleet",
      {
        coreId: "core-a",
        event: {
          eventId: 3,
          ts: 1,
          kind: "session:finished",
          ptyId: null,
          taskId: "task-fallback",
          payload: JSON.stringify({ projectId: "p" }),
        },
      },
      null,
    );
    expect(finish?.sessionId).toBe("task-fallback");
    expect(finish?.coreAlias).toBeNull();
  });

  it("returns null when payload JSON is malformed", () => {
    const finish = normalizeSessionFinishedEvent("fleet", {
      coreId: "core-a",
      event: {
        eventId: 1,
        ts: 1,
        kind: "session:finished",
        ptyId: null,
        taskId: null,
        payload: "not-json",
      },
    });
    expect(finish).toBeNull();
  });

  it("returns null when kind is not session:finished", () => {
    const finish = normalizeSessionFinishedEvent("fleet", {
      coreId: "core-a",
      event: {
        eventId: 1,
        ts: 1,
        kind: "pty:exit",
        ptyId: "p",
        taskId: null,
        payload: "{}",
      },
    });
    expect(finish).toBeNull();
  });
});
