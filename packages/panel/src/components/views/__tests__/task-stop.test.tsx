// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import { formatTaskDispatchComment, type TaskStatus } from "~/shared/tasks";
import type { TaskCommentDto, TaskDto } from "~/shared/task-wire";

// Stop a running Task from its detail (#723): the button sits on the current attempt's dispatch comment.

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
  const task: TaskDto = { id: "T-7", title: "Rotate keys", description: "", status, coreId: "core_a", agent: null, attemptCount: opts.attemptCount ?? 1, dispatchedAt: 1, lastError: null, createdAt: 1, updatedAt: 1 };
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

const stopButtons = () => screen.queryAllByRole("button", { name: /^Stop$/ });

beforeEach(() => {
  cores.length = 0;
  cores.push({ id: "core_a", endpoint: "wss://x", label: "berlin", lastEventId: 0, createdAt: 0, updatedAt: 0, dial: { coreId: "core_a", state: "connected", lastSeenAt: 1 } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Stop a Task", () => {
  it("shows Stop only on the current attempt's dispatch comment of an in_progress Task", async () => {
    mount("in_progress", { attemptCount: 2, comments: [dispatchComment(1, "s-1"), dispatchComment(2, "s-2")] });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Open session/ })).toHaveLength(2));
    expect(stopButtons()).toHaveLength(1);
  });

  it("offers one header Stop for an in_progress Task with no dispatch comment, and it stops the Task", async () => {
    api.stopTask.mockResolvedValue({ task: {}, session: null });
    mount("in_progress", { attemptCount: 1, comments: [] });
    await screen.findByRole("button", { name: /^Edit$/ });
    expect(stopButtons()).toHaveLength(1);
    fireEvent.click(stopButtons()[0]!);
    const dialog = await screen.findByRole("dialog", { name: /Stop Task\?/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Stop$/ }));
    await waitFor(() => expect(api.stopTask).toHaveBeenCalledWith("T-7", {}));
  });

  it("offers one Stop, outside the old attempt's comment, when only an earlier attempt has a dispatch comment", async () => {
    mount("in_progress", { attemptCount: 2, comments: [dispatchComment(1, "s-1")] });
    const open = await screen.findByRole("button", { name: /Open session/ });
    expect(stopButtons()).toHaveLength(1);
    expect(open.closest("article")!.contains(stopButtons()[0]!)).toBe(false);
  });

  it("shows no Stop for a failed Task without comments", async () => {
    mount("failed", { comments: [] });
    await screen.findByRole("button", { name: /^Edit$/ });
    expect(stopButtons()).toHaveLength(0);
  });

  it.each(["draft", "assigned", "failed", "done"] as const)("hides Stop for a %s Task", async (status) => {
    mount(status);
    await screen.findByRole("button", { name: /Open session/ });
    expect(stopButtons()).toHaveLength(0);
  });

  it("confirms with an optional reason and calls the server", async () => {
    api.stopTask.mockResolvedValue({ task: {}, session: { coreId: "core_a", sessionId: "s-1", outcome: "stopped", detail: null } });
    mount("in_progress");
    fireEvent.click(await screen.findByRole("button", { name: /^Stop$/ }));
    expect(api.stopTask).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: /Stop Task\?/ });
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "hung on a prompt" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Stop$/ }));
    await waitFor(() => expect(api.stopTask).toHaveBeenCalledWith("T-7", { reason: "hung on a prompt" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Stop Task\?/ })).toBeNull());
    expect(screen.queryByText(/could not be stopped/)).toBeNull();
  });

  it("sends no reason when none is typed", async () => {
    api.stopTask.mockResolvedValue({ task: {}, session: null });
    mount("in_progress");
    fireEvent.click(await screen.findByRole("button", { name: /^Stop$/ }));
    const dialog = await screen.findByRole("dialog", { name: /Stop Task\?/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Stop$/ }));
    await waitFor(() => expect(api.stopTask).toHaveBeenCalledWith("T-7", {}));
  });

  it("shows the server's refusal in the dialog", async () => {
    api.stopTask.mockRejectedValue(new Error("a Task that is done is not running: only an in_progress Task can be stopped"));
    mount("in_progress");
    fireEvent.click(await screen.findByRole("button", { name: /^Stop$/ }));
    const dialog = await screen.findByRole("dialog", { name: /Stop Task\?/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Stop$/ }));
    expect(await within(dialog).findByText(/is not running/)).toBeTruthy();
  });

  it("warns when the Core is offline and keeps Stop enabled", async () => {
    cores[0]!.dial = { coreId: "core_a", state: "unreachable", lastSeenAt: 1 };
    mount("in_progress");
    const stop = (await screen.findByRole("button", { name: /^Stop$/ })) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(stop.title).toMatch(/Core is offline/);
    fireEvent.click(stop);
    const dialog = await screen.findByRole("dialog", { name: /Stop Task\?/ });
    expect(within(dialog).getByText(/The Core is offline; the Task will be failed, its Session may keep running/)).toBeTruthy();
  });

  it("tells the operator when the Session could not be stopped", async () => {
    api.stopTask.mockResolvedValue({ task: {}, session: { coreId: "core_a", sessionId: "s-1", outcome: "unreachable", detail: "Core offline" } });
    mount("in_progress");
    fireEvent.click(await screen.findByRole("button", { name: /^Stop$/ }));
    const dialog = await screen.findByRole("dialog", { name: /Stop Task\?/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Stop$/ }));
    expect(await screen.findByText(/could not be stopped \(unreachable\): Core offline/)).toBeTruthy();
  });

  it("points Comment & re-assign at Stop while the Task is in_progress", async () => {
    mount("in_progress");
    const button = (await screen.findByRole("button", { name: /Comment & re-assign/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Stop the Task first");
  });
});
