// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import { formatTaskDispatchComment, type TaskStatus } from "~/shared/tasks";
import type { TaskCommentDto, TaskDto } from "~/shared/task-wire";

// A comment on a running Task is typed into its Session unless the Operator turns it off (#935, now mode).

vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock("~/lib/session-notification-store", () => ({ requestSessionOpen: vi.fn() }));

const cores = vi.hoisted((): CoreWithDial[] => []);
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores, fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({
    listSessionRows: async () => ({ sessions: [], archivedCount: 0 }),
    listArchivedSessions: async () => [],
  }),
}));

const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  getTask: vi.fn(),
  listCoreAgents: vi.fn(async () => ({ agents: [] })),
  commentOnTask: vi.fn(),
  setTaskStatus: vi.fn(),
  stopTask: vi.fn(),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { TaskDetail } = await import("../TaskDetail");

function dispatchComment(attempt: number, sessionId: string): TaskCommentDto {
  return {
    id: `k-${attempt}`,
    taskId: "T-7",
    authorKind: "system",
    authorName: "Panel",
    sourceFile: null,
    body: formatTaskDispatchComment({ attempt, agentName: "OpenCode", harness: "opencode", coreId: "core_a", sessionId }),
    createdAt: attempt,
  };
}

function mount(status: TaskStatus, opts: { attemptCount?: number; comments?: TaskCommentDto[] } = {}) {
  const task: TaskDto = { id: "T-7", title: "Rotate keys", description: "", status, coreId: "core_a", agent: null, attemptCount: opts.attemptCount ?? 1, dispatchedAt: 1, lastError: null, timeoutMinutes: 60, sessionState: null, sessionStateAt: null, createdAt: 1, updatedAt: 1 };
  api.getTask.mockResolvedValue({ task, comments: opts.comments ?? [dispatchComment(1, "s-1")] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <TaskDetail taskId="T-7" onClose={vi.fn()} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cores.length = 0;
  cores.push({ id: "core_a", endpoint: "wss://x", label: "berlin", lastEventId: 0, createdAt: 0, updatedAt: 0, dial: { coreId: "core_a", state: "connected", lastSeenAt: 1 } });
  api.commentOnTask.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function write(text: string) {
  const box = await screen.findByLabelText("Comment");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
}

describe("Comment on a running Task (#935)", () => {
  it("asks for delivery into the Session by default", async () => {
    mount("in_progress");
    await write("use the other branch");
    await waitFor(() => expect(api.commentOnTask).toHaveBeenCalledWith("T-7", { body: "use the other branch", reassign: false, deliver: "now" }));
  });

  it("is a note only when the Operator turns the choice off", async () => {
    mount("in_progress");
    fireEvent.click(await screen.findByRole("checkbox", { name: /type it into the running Session/ }));
    await write("just a note");
    await waitFor(() => expect(api.commentOnTask).toHaveBeenCalledWith("T-7", { body: "just a note", reassign: false }));
  });

  it("offers no choice on a finished Task and asks for no delivery", async () => {
    mount("done");
    await write("thanks");
    expect(screen.queryByRole("checkbox", { name: /running Session/ })).toBeNull();
    await waitFor(() => expect(api.commentOnTask).toHaveBeenCalledWith("T-7", { body: "thanks", reassign: false }));
  });
});
