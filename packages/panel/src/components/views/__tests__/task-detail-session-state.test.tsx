// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { TaskDto } from "~/shared/task-wire";

// #954: the Session state under the status in Task detail, with when it began.
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock("~/lib/session-notification-store", () => ({ requestSessionOpen: vi.fn() }));
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores: [], fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({ listSessionRows: async () => ({ sessions: [], archivedCount: 0 }), listArchivedSessions: async () => [] }),
}));
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  getTask: vi.fn(),
  listCoreAgents: vi.fn(async () => ({ agents: [] })),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));
const { TaskDetail } = await import("../TaskDetail");

function mount(over: Partial<TaskDto>) {
  const task: TaskDto = { id: "T-9", title: "Rotate keys", description: "", status: "in_progress", coreId: null, agent: null, attemptCount: 1, dispatchedAt: 1, lastError: null, timeoutMinutes: 60, sessionState: null, sessionStateAt: null, createdAt: 1, updatedAt: 1, ...over };
  api.getTask.mockResolvedValue({ task, comments: [] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <KeybindingsProvider>
        <TaskDetail taskId="T-9" onClose={vi.fn()} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}
afterEach(cleanup);

describe("Task detail Session state (#954)", () => {
  it("shows the badge with a relative time for needs-input", async () => {
    mount({ sessionState: "needs-input", sessionStateAt: Date.now() - 5 * 60_000 });
    const line = await waitFor(() => {
      const el = document.querySelector("[data-session-state-line]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(line.textContent).toContain("Needs input");
    expect(line.textContent).toMatch(/since .*5/);
    expect(screen.getByText("In progress")).toBeTruthy();
  });
  it.each(["working", "exited", null] as const)("shows no line for %s", async (sessionState) => {
    mount({ sessionState, sessionStateAt: sessionState ? 1 : null });
    await screen.findByText("In progress");
    expect(document.querySelector("[data-session-state-line]")).toBeNull();
  });
});
