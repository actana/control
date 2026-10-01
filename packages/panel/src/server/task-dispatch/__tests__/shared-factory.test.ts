import { describe, expect, it, vi } from "vitest";
import type { CoreShared } from "@actana/sdk/shared";
import { SharedChangeFeed, createSharedFactory } from "../shared-factory";
import { launchCommand } from "../session-starter";
import { buildTaskPrompt } from "../task-prompt";
import { taskTimeoutMs, TASK_TIMEOUT_ENV } from "../index";

const fake = (name: string) => ({ name }) as unknown as CoreShared;

describe("which CoreShared the watcher reads through", () => {
  it("uses the S3 mode when the Panel has storage configured", async () => {
    const s3 = vi.fn(async () => fake("s3"));
    const throughCore = vi.fn(async () => fake("core"));
    const sharedFor = createSharedFactory({ s3, throughCore });

    expect(await sharedFor("core_1")).toEqual(fake("s3"));
    expect(s3).toHaveBeenCalledWith("core_1");
    expect(throughCore).not.toHaveBeenCalled();
  });

  it("uses the through-the-Core mode when it has none", async () => {
    const throughCore = vi.fn(async () => fake("core"));

    expect(await createSharedFactory({ throughCore })("core_1")).toEqual(fake("core"));
    expect(await createSharedFactory({ s3: null, throughCore })("core_2")).toEqual(fake("core"));
    expect(throughCore).toHaveBeenCalledTimes(2);
  });
});

describe("the shared:changed feed behind the through-the-Core mode", () => {
  const payload = (path: string, mtime = 5, deleted = false) => JSON.stringify({ path, size: 3, mtime, deleted });

  it("replays what happened after an event id, per Core, and reports its tip", async () => {
    const feed = new SharedChangeFeed();
    feed.push("a", 4, payload("tasks/t/success.md", 100));
    feed.push("a", 6, payload("tasks/t/fail.md", 200));
    feed.push("b", 9, payload("other", 300));

    const a = feed.source("a");
    expect(await a.tip()).toBe(6);
    expect((await a.since(4)).map((e) => e.path)).toEqual(["tasks/t/fail.md"]);
    expect((await a.since(0)).map((e) => [e.eventId, e.mtime])).toEqual([[4, 100], [6, 200]]);
    expect(await feed.source("nobody").tip()).toBe(0);
  });

  it("ignores a payload that is not a change, and an event it already has", async () => {
    const feed = new SharedChangeFeed();
    feed.push("a", 1, "not json");
    feed.push("a", 2, JSON.stringify({ path: 7, deleted: false }));
    feed.push("a", 3, payload("x"));
    feed.push("a", 3, payload("x-again"));

    expect((await feed.source("a").since(0)).map((e) => e.path)).toEqual(["x"]);
  });

  it("listens to shared:changed on every link the manager has, and to nothing else", async () => {
    let listener: ((m: { event: { eventId: number; kind: string; payload: string } }) => void) | null = null;
    const unsubscribe = vi.fn();
    const manager = {
      onClient: (cb: (coreId: string, client: unknown) => void) => {
        cb("core_1", { onEvent: (l: typeof listener) => ((listener = l), unsubscribe) });
        return () => undefined;
      },
    };
    const feed = new SharedChangeFeed();
    const detach = feed.attach(manager as never);

    listener!({ event: { eventId: 1, kind: "session:updated", payload: payload("ignored") } });
    listener!({ event: { eventId: 2, kind: "shared:changed", payload: payload("tasks/t/success.md") } });

    expect((await feed.source("core_1").since(0)).map((e) => e.path)).toEqual(["tasks/t/success.md"]);
    detach();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe("how a Session is launched", () => {
  it.each([
    [{ harness: "claude-code", model: null, flags: [] }, "claude"],
    [{ harness: "claude-code", model: "claude-sonnet-5-5", flags: [] }, "claude --model claude-sonnet-5-5"],
    [{ harness: "codex", model: null, flags: [] }, "codex --enable hooks"],
  ] as const)("%j starts as `%s`", (request, command) => {
    expect(launchCommand(request)).toBe(command);
  });

  it("adds the harness's own auto-mode flag for skip-permissions, and none where it has none", () => {
    expect(launchCommand({ harness: "claude-code", model: null, flags: ["skip-permissions"] })).toBe("claude --dangerously-skip-permissions");
    expect(launchCommand({ harness: "opencode", model: null, flags: ["skip-permissions"] })).toBe("opencode");
  });
});

describe("the Task prompt", () => {
  const task = { id: "task_9", title: "  Title  ", description: "" };
  const comment = (kind: string, name: string, body: string) =>
    ({ id: name, seq: 1, taskId: "task_9", ownerId: 1, authorKind: kind, authorName: name, sourceFile: null, body, createdAt: 1 }) as never;

  it("says there is no description, and lists no comments, when there are none", () => {
    const prompt = buildTaskPrompt(task, [], 1);
    expect(prompt).toContain("Task: Title");
    expect(prompt).toContain("Description:\n(none)");
    expect(prompt).not.toContain("Comments so far");
  });

  it("keeps the last 20 comments and cuts a long one", () => {
    const many = Array.from({ length: 25 }, (_, i) => comment("user", `u${i}`, `note ${i}`));
    const prompt = buildTaskPrompt(task, [...many, comment("agent", "long", "x".repeat(5_000))], 2);
    expect(prompt).not.toContain("note 5 ");
    expect(prompt).toContain("note 24");
    expect(prompt).toContain(`${"x".repeat(4_000)} [cut]`);
    expect(prompt).not.toContain("x".repeat(4_001));
    expect(prompt).toContain("attempt 2");
  });
});

describe("the timeout setting", () => {
  it("defaults to an hour and reads minutes from the environment", () => {
    expect(taskTimeoutMs({})).toBe(3_600_000);
    expect(taskTimeoutMs({ [TASK_TIMEOUT_ENV]: "5" })).toBe(300_000);
    expect(taskTimeoutMs({ [TASK_TIMEOUT_ENV]: "nope" })).toBe(3_600_000);
    expect(taskTimeoutMs({ [TASK_TIMEOUT_ENV]: "0" })).toBe(3_600_000);
  });
});
