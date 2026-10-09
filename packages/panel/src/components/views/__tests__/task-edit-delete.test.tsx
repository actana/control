// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { TaskDto } from "~/shared/task-wire";
import type { TaskStatus } from "~/shared/tasks";

// Edit and Delete in a Task's detail (#722): both call the server, and both are off while the Task is in_progress.

vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores: [], fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));

const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  getTask: vi.fn(),
  listCoreAgents: vi.fn(async () => ({ agents: [] })),
  commentOnTask: vi.fn(),
  setTaskStatus: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { TaskDetail } = await import("../TaskDetail");

function mount(status: TaskStatus, onClose = vi.fn()) {
  const task: TaskDto = { id: "T-7", title: "Old title", description: "Old body", status, coreId: "c1", agent: null, attemptCount: 0, dispatchedAt: null, lastError: null, createdAt: 1, updatedAt: 1 };
  api.getTask.mockResolvedValue({ task, comments: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <TaskDetail taskId="T-7" onClose={onClose} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
  return onClose;
}

const button = async (name: RegExp) => (await screen.findByRole("button", { name })) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Edit a Task", () => {
  it("saves the new title and description through the server", async () => {
    mount("draft");
    api.updateTask.mockResolvedValue({ task: {} });
    fireEvent.click(await button(/^Edit$/));
    const edit = screen.getByRole("region", { name: "Edit Task" });
    fireEvent.change(within(edit).getByLabelText("Title"), { target: { value: "New title" } });
    fireEvent.change(within(edit).getByLabelText("Description"), { target: { value: "New body" } });
    fireEvent.click(within(edit).getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith("T-7", { title: "New title", description: "New body" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Edit Task" })).toBeNull());
  });

  it("keeps Save off for an empty title, and Cancel leaves the Task alone", async () => {
    mount("done");
    fireEvent.click(await button(/^Edit$/));
    const edit = screen.getByRole("region", { name: "Edit Task" });
    fireEvent.change(within(edit).getByLabelText("Title"), { target: { value: "   " } });
    expect((within(edit).getByRole("button", { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(edit).getByRole("button", { name: /Cancel/ }));
    expect(screen.queryByRole("region", { name: "Edit Task" })).toBeNull();
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    mount("assigned");
    api.updateTask.mockRejectedValue(new Error("a Task that is in_progress cannot be edited"));
    fireEvent.click(await button(/^Edit$/));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(await screen.findByText(/cannot be edited/)).toBeTruthy();
  });
});

describe("Delete a Task", () => {
  it("asks first, deletes through the server and closes the detail", async () => {
    const onClose = mount("failed");
    api.deleteTask.mockResolvedValue(undefined);
    fireEvent.click(await button(/^Delete$/));
    const dialog = await screen.findByRole("dialog", { name: /Delete Task\?/ });
    expect(api.deleteTask).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(api.deleteTask).toHaveBeenCalledWith("T-7"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("A running Task", () => {
  it("has Edit and Delete off", async () => {
    mount("in_progress");
    expect((await button(/^Edit$/)).disabled).toBe(true);
    expect((await button(/^Delete$/)).disabled).toBe(true);
  });
});
