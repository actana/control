// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import type { TaskDto } from "~/shared/task-wire";

// Attachments in the New Task dialog (files or a whole folder) and in the Task detail composer (a file) (#568, #571),
// against a faked API: what is asserted is what the UI sends, in what shape, and what it shows when the server refuses.

const cores: CoreWithDial[] = [{ id: "c1", endpoint: "wss://x", label: "workstation-berlin", lastEventId: 0, createdAt: 0, updatedAt: 0, dial: { coreId: "c1", state: "connected", lastSeenAt: 1 } }];
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores, fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));

const finished: TaskDto = { id: "t4", title: "Review PR", description: "", status: "failed", coreId: "c1", agent: "ag-c1", attemptCount: 1, dispatchedAt: 1, lastError: null, createdAt: 1, updatedAt: 1 };
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  listTasks: vi.fn(async () => ({ tasks: [] })),
  getTask: vi.fn(async () => ({ task: finished, comments: [] })),
  listCoreAgents: vi.fn(async () => ({ agents: [{ id: "ag-c1", coreId: "c1", name: "claude-code", harness: "claude-code", model: null, isDefault: true }] })),
  createTask: vi.fn(async (_body: Record<string, unknown>, _files?: unknown) => ({ task: { ...finished, id: "new" } })),
  commentOnTask: vi.fn(async (_id: string, _body: unknown, _files?: unknown) => ({})),
  setTaskStatus: vi.fn(async () => ({})),
}));
const { FakeApiError } = vi.hoisted(() => ({
  FakeApiError: class extends Error {
    constructor(message: string, readonly status: number, readonly body: unknown) {
      super(message);
    }
  },
}));
vi.mock("~/lib/api", () => ({ api, ApiError: FakeApiError }));

const { NewTaskDialog } = await import("../NewTaskDialog");
const { TaskDetail } = await import("../TaskDetail");

function mount(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>{ui}</KeybindingsProvider>
    </QueryClientProvider>,
  );
}

/** A file as `<input type=file webkitdirectory>` hands it over: its name, and its path inside the picked folder. */
function file(name: string, content: string, relativePath?: string): File {
  const f = new File([content], name);
  if (relativePath) Object.defineProperty(f, "webkitRelativePath", { value: relativePath });
  return f;
}
const pick = (input: HTMLElement, files: File[]) => fireEvent.change(input, { target: { files } });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear();
});
afterEach(cleanup);

async function openDialog(onCreated = vi.fn()) {
  mount(<NewTaskDialog open onClose={() => {}} initialCoreId="c1" onCreated={onCreated} />);
  fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Prove installs" } });
  await screen.findByRole("radio", { name: /claude-code/ });
  return onCreated;
}

describe("New Task dialog attachments", () => {
  it("attaches files and a whole folder, keeping the folder's tree, and sends them with the Task", async () => {
    await openDialog();
    pick(screen.getByLabelText("Attach files"), [file("brief.md", "# b")]);
    pick(screen.getByLabelText("Attach folder"), [file("a.png", "1", "mock/a.png"), file("b.png", "2", "mock/deep/b.png")]);
    expect(screen.getByText("brief.md")).toBeTruthy();
    expect(screen.getByText("mock/deep/b.png")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create & assign" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    const [body, sent] = api.createTask.mock.calls[0]!;
    expect(body).toMatchObject({ title: "Prove installs", coreId: "c1", startNow: true });
    expect((sent as { path: string }[]).map((a) => a.path)).toEqual(["brief.md", "mock/a.png", "mock/deep/b.png"]);
  });

  it("removes an attachment from the list, and sends no files when none are attached", async () => {
    await openDialog();
    pick(screen.getByLabelText("Attach files"), [file("one.txt", "1"), file("two.txt", "2")]);
    fireEvent.click(screen.getByRole("button", { name: "Remove one.txt" }));
    expect(screen.queryByText("one.txt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    expect((api.createTask.mock.calls[0]![1] as { path: string }[]).map((a) => a.path)).toEqual(["two.txt"]);

    cleanup();
    api.createTask.mockClear();
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    expect(api.createTask.mock.calls[0]).toHaveLength(1);
  });

  it("leaves out a path the Panel would refuse and a repeat, and says why", async () => {
    await openDialog();
    pick(screen.getByLabelText("Attach folder"), [file("x", "x", "../escape/x"), file("ok.txt", "ok", "dir/ok.txt")]);
    pick(screen.getByLabelText("Attach files"), [file("ok.txt", "again", "dir/ok.txt")]);
    expect(screen.getByText("dir/ok.txt")).toBeTruthy();
    expect(screen.getByText(/Left out dir\/ok\.txt: it is already attached/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    expect((api.createTask.mock.calls[0]![1] as { path: string }[]).map((a) => a.path)).toEqual(["dir/ok.txt"]);
  });

  it("shows the server's error, says the Task stayed a draft, and will not create it a second time", async () => {
    const onCreated = await openDialog();
    api.createTask.mockRejectedValueOnce(new FakeApiError("The attachment big.bin could not be written: too big", 413, { error: "The attachment big.bin could not be written: too big", taskId: "kept-1", path: "big.bin" }));
    pick(screen.getByLabelText("Attach files"), [file("big.bin", "x")]);
    fireEvent.click(screen.getByRole("button", { name: "Create & assign" }));
    expect(await screen.findByText(/big\.bin could not be written/)).toBeTruthy();
    expect(screen.getByText(/saved as a draft and was not assigned/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create & assign" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save as draft" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Open the draft" }));
    expect(onCreated).toHaveBeenCalledWith("kept-1");
    expect(api.createTask).toHaveBeenCalledTimes(1);
  });
});

describe("Task detail composer attachments", () => {
  async function composer() {
    mount(<TaskDetail taskId="t4" onClose={() => {}} />);
    await screen.findByRole("heading", { name: "Review PR" });
  }

  it("attaches a file to a comment, with no folder button, and sends it with Comment & re-assign", async () => {
    await composer();
    expect(screen.queryByLabelText("Attach folder")).toBeNull();
    pick(screen.getByLabelText("Attach files"), [file("trace.log", "log")]);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "see trace" } });
    fireEvent.click(screen.getByRole("button", { name: /Comment & re-assign/ }));
    await waitFor(() => expect(api.commentOnTask).toHaveBeenCalledTimes(1));
    const [id, body, sent] = api.commentOnTask.mock.calls[0]!;
    expect(id).toBe("t4");
    expect(body).toEqual({ body: "see trace", reassign: true });
    expect((sent as { path: string }[]).map((a) => a.path)).toEqual(["trace.log"]);
    // Sent: the list is cleared with the draft.
    await waitFor(() => expect(screen.queryByText("trace.log")).toBeNull());
  });

  it("lets a file be the whole comment, and keeps the file and the draft when the server refuses", async () => {
    await composer();
    pick(screen.getByLabelText("Attach files"), [file("only.txt", "o")]);
    const commentBtn = screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement;
    expect(commentBtn.disabled).toBe(false);
    api.commentOnTask.mockRejectedValueOnce(new FakeApiError("only.txt is already attached to this Task: rename the file.", 409, null));
    fireEvent.click(commentBtn);
    expect(await screen.findByText(/already attached to this Task/)).toBeTruthy();
    expect(screen.getByText("only.txt")).toBeTruthy();
  });

  it("sends a plain comment as before, with no files argument", async () => {
    await composer();
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "note" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(api.commentOnTask).toHaveBeenCalledTimes(1));
    expect(api.commentOnTask.mock.calls[0]).toHaveLength(2);
  });
});
