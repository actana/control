import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../events";

let nextId = 0;
const appendMock = vi.hoisted(() =>
  vi.fn(async (_ownerId: number, _kind: string, _payload: string, _opts?: unknown) => {
    return 0;
  }),
);

vi.mock("../repositories/event-log.repo", () => ({
  appendEventLogRow: (...args: unknown[]) =>
    appendMock(...(args as [number, string, string, unknown?])),
}));

const { registerEventLogRecorder } = await import("../event-log-recorder");

async function flushRecorder(n = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(appendMock.mock.calls.length).toBeGreaterThanOrEqual(n);
  });
}

describe("registerEventLogRecorder", () => {
  beforeEach(() => {
    nextId = 0;
    appendMock.mockClear();
    appendMock.mockImplementation(async () => ++nextId);
  });

  afterEach(() => {
    appendMock.mockReset();
  });

  it("appends session:created with session_id filled from the `id` field", async () => {
    registerEventLogRecorder();
    events.emit("session:created", { id: "t1" });
    await flushRecorder();

    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, kind, payload, opts] = appendMock.mock.calls[0]!;
    expect(kind).toBe("session:created");
    expect(opts).toMatchObject({ sessionId: "t1" });
    expect(JSON.parse(payload as string)).toEqual({ id: "t1" });
  });

  it("appends session:updated with session_id filled from the `id` field", async () => {
    registerEventLogRecorder();
    events.emit("session:updated", { id: "t2" });
    await flushRecorder();

    const [, kind, , opts] = appendMock.mock.calls.at(-1)!;
    expect(kind).toBe("session:updated");
    expect(opts).toMatchObject({ sessionId: "t2" });
  });

  it("appends session:question with session_id filled from the `sessionId` field", async () => {
    registerEventLogRecorder();
    events.emit("session:question", {
      sessionId: "t9",
      questionId: "q1",
      questions: [],
    });
    await flushRecorder();

    const [, kind, , opts] = appendMock.mock.calls.at(-1)!;
    expect(kind).toBe("session:question");
    expect(opts).toMatchObject({ sessionId: "t9" });
  });

  it("assigns sequential monotonic eventIds across emits", async () => {
    registerEventLogRecorder();
    appendMock.mockClear();
    nextId = 0;
    events.emit("session:created", { id: "t1" });
    events.emit("session:updated", { id: "t1" });
    await flushRecorder(2);

    const ids = await Promise.all(appendMock.mock.results.map((r) => r.value));
    expect(ids).toEqual([1, 2]);
  });

  it("is idempotent — registering twice does not double-record", async () => {
    registerEventLogRecorder();
    registerEventLogRecorder();
    appendMock.mockClear();
    events.emit("session:created", { id: "t1" });
    await flushRecorder();
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when appendEventLogRow fails (best-effort durability)", async () => {
    registerEventLogRecorder();
    appendMock.mockRejectedValueOnce(new Error("db down"));
    expect(() => events.emit("session:created", { id: "t1" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
