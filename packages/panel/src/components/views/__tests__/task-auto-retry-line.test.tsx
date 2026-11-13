// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { TaskDto } from "~/shared/task-wire";

// The Task detail's auto-retry line (#958).

vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores: [], fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));
let task: TaskDto;
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  getTask: vi.fn(),
  listCoreAgents: vi.fn(async () => ({ agents: [] })),
  listTasksPage: vi.fn(async () => ({ tasks: [], nextCursor: null })),
  getTaskCounts: vi.fn(async () => ({ byStatus: {}, byCore: {} })),
  updateTask: vi.fn(),
  commentOnTask: vi.fn(),
  setTaskStatus: vi.fn(),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));
const { TaskDetail } = await import("../TaskDetail");

const base: TaskDto = { id: "T-9", title: "Orchestrate", description: "", status: "in_progress", coreId: "c1", agent: "ag", attemptCount: 2, dispatchedAt: 1, lastError: null, timeoutMinutes: 60, sessionState: null, sessionStateAt: null, createdAt: 1, updatedAt: 1 };

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <TaskDetail taskId="T-9" onClose={vi.fn()} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  api.getTask.mockImplementation(async () => ({ task, comments: [] }));
});
afterEach(cleanup);

describe("Task detail auto-retry line", () => {
  it("is absent for a Task without autoRetry", async () => {
    task = { ...base, autoRetry: null };
    mount();
    await screen.findByText("Orchestrate");
    expect(document.querySelector("[data-auto-retry-line]")).toBeNull();
  });

  it("shows the attempts used and the allowed", async () => {
    task = { ...base, autoRetry: { maxAttempts: 3, retries: 1, pendingAt: null, notice: null } };
    mount();
    const line = await waitForLine();
    expect(line.textContent).toContain("Auto-retry");
    expect(line.textContent).toContain("1 of 2");
    expect(line.textContent).toContain("up to 3 attempts");
  });

  it("shows a pending retry and the latest notice", async () => {
    task = {
      ...base,
      status: "assigned",
      autoRetry: { maxAttempts: 3, retries: 1, pendingAt: Date.now() + 5 * 60_000, notice: { id: 2, kind: "retry", text: "Auto-retry 2/3: previous Session exited (code 143) without a result" } },
    };
    mount();
    const line = await waitForLine();
    expect(line.textContent).toMatch(/next attempt in/);
    expect(line.textContent).toContain("Auto-retry 2/3: previous Session exited (code 143) without a result");
  });
});

async function waitForLine() {
  await screen.findByText("Orchestrate");
  return await vi.waitFor(() => {
    const el = document.querySelector("[data-auto-retry-line]");
    if (!el) throw new Error("no line");
    return el;
  });
}
