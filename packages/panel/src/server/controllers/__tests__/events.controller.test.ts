import { describe, expect, it } from "vitest";
import { stream } from "../events.controller";
import { events } from "../../events";

async function readNextEvent(response: Response): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>;
  text: string;
}> {
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  return {
    reader,
    text: new TextDecoder().decode(chunk.value),
  };
}

describe("events controller", () => {
  // The stream is gated by the Operator session cookie in api-router (see
  // __tests__/api-auth.test.ts); by the time this controller runs, the caller
  // is authenticated.
  it("opens an SSE stream", async () => {
    const response = stream();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await response.body?.cancel();
  });

  it("delivers emitted app events to a subscribed stream", async () => {
    const response = stream();
    const { reader } = await readNextEvent(response);

    events.emit("task:updated", { id: "task-1", projectId: "project-1" });

    const next = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(next.value);
    expect(text).toContain("task-1");
  });
});
