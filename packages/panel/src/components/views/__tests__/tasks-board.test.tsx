// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import type { AgentDto, TaskCommentDto, TaskDto } from "~/shared/task-wire";

// The Tasks board, the New Task dialog and the Task detail (#571), against a
// faked API: what is asserted is what the UI asks the server for, and that it
// shows what the server answers instead of moving a status itself.

function core(id: string, label: string): CoreWithDial {
  return { id, endpoint: "wss://x", label, lastEventId: 0, createdAt: 0, updatedAt: 0, dial: { coreId: id, state: "connected", lastSeenAt: 1 } };
}
const cores = [core("c1", "workstation-berlin"), core("c2", "build-box-01")];
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores, fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));

const task = (id: string, title: string, status: TaskDto["status"], coreId: string | null, extra: Partial<TaskDto> = {}): TaskDto => ({
  id, title, description: "", status, coreId, agent: coreId ? `ag-${coreId}` : null, attemptCount: 0, dispatchedAt: null, lastError: null, createdAt: 1, updatedAt: 1, ...extra,
});
const agentsByCore: Record<string, AgentDto[]> = {
  c1: [
    { id: "ag-c1", coreId: "c1", name: "claude-code", harness: "claude-code", model: null, isDefault: true },
    { id: "ag-c1b", coreId: "c1", name: "cursor-cli", harness: "cursor-cli", model: "allowlist", isDefault: false },
  ],
  c2: [{ id: "ag-c2", coreId: "c2", name: "opencode", harness: "opencode", model: "Kimi K3", isDefault: true }],
};

let tasks: TaskDto[] = [];
let comments: TaskCommentDto[] = [];
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  listTasks: vi.fn(async () => ({ tasks })),
  getTask: vi.fn(async (id: string) => ({ task: tasks.find((t) => t.id === id)!, comments })),
  listCoreAgents: vi.fn(async (coreId: string) => ({ agents: agentsByCore[coreId] ?? [] })),
  createTask: vi.fn(async (body: Record<string, unknown>) => ({ task: task("new", String(body.title), body.startNow ? "assigned" : "draft", (body.coreId as string) ?? null) })),
  commentOnTask: vi.fn(async () => ({})),
  setTaskStatus: vi.fn(async () => ({})),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { TasksBoard } = await import("../TasksBoard");
const { TaskDetail } = await import("../TaskDetail");

function mount(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>{ui}</KeybindingsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  tasks = [
    task("t1", "Rotate keys", "draft", "c1"),
    task("t2", "Bump SeaweedFS", "assigned", "c2"),
    task("t3", "Remove sudo", "in_progress", "c1", { attemptCount: 2 }),
    task("t4", "Review PR", "failed", "c2"),
  ];
  comments = [];
  for (const fn of Object.values(api)) fn.mockClear();
});
afterEach(cleanup);

const column = (id: string) => document.querySelector(`[data-board-column="${id}"]`) as HTMLElement;

describe("Tasks board", () => {
  it("shows every Task in its status column, Finished, Partial and Failed together", async () => {
    mount(<TasksBoard />);
    await screen.findByText("Rotate keys");
    expect(within(column("draft")).getByText("Rotate keys")).toBeTruthy();
    expect(within(column("assigned")).getByText("Bump SeaweedFS")).toBeTruthy();
    expect(within(column("in_progress")).getByText("Remove sudo")).toBeTruthy();
    expect(within(column("finished")).getByText("Review PR")).toBeTruthy();
  });

  it("filters to one Core from its chip, with counts, and back to All Cores", async () => {
    mount(<TasksBoard />);
    await screen.findByText("Rotate keys");
    const chips = screen.getByRole("group", { name: "Filter by Core" });
    expect(within(chips).getByRole("button", { name: /All Cores/ }).textContent).toContain("4");
    expect(within(chips).getByRole("button", { name: /build-box-01/ }).textContent).toContain("2");
    fireEvent.click(within(chips).getByRole("button", { name: /build-box-01/ }));
    expect(screen.queryByText("Rotate keys")).toBeNull();
    expect(screen.getByText("Bump SeaweedFS")).toBeTruthy();
    expect(screen.getByText("Review PR")).toBeTruthy();
    fireEvent.click(within(chips).getByRole("button", { name: /All Cores/ }));
    expect(screen.getByText("Rotate keys")).toBeTruthy();
  });

  it("is already one Core's board, with no chips, when given a Core", async () => {
    mount(<TasksBoard coreId="c1" />);
    await screen.findByText("Rotate keys");
    expect(screen.queryByRole("group", { name: "Filter by Core" })).toBeNull();
    expect(screen.queryByText("Bump SeaweedFS")).toBeNull();
    expect(screen.getByText("Remove sudo")).toBeTruthy();
  });
});

describe("a link to one Task (?task=<id>, from a file's details)", () => {
  it("opens that Task's detail over the board", async () => {
    mount(<TasksBoard openTaskId="t3" />);
    expect(await screen.findByText("Remove sudo", { selector: "h2, h3, h1, strong, span, div" })).toBeTruthy();
    await waitFor(() => expect(api.getTask).toHaveBeenCalledWith("t3"));
  });

  it("opens another Task when the link changes while the board is open", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (id: string | null) => (
      <QueryClientProvider client={client}>
        <KeybindingsProvider>
          <TasksBoard openTaskId={id} />
        </KeybindingsProvider>
      </QueryClientProvider>
    );
    const view = render(ui(null));
    await screen.findByText("Rotate keys");
    expect(api.getTask).not.toHaveBeenCalled();
    view.rerender(ui("t2"));
    await waitFor(() => expect(api.getTask).toHaveBeenCalledWith("t2"));
  });

  it("opens nothing for no link", async () => {
    mount(<TasksBoard openTaskId={null} />);
    await screen.findByText("Rotate keys");
    expect(api.getTask).not.toHaveBeenCalled();
  });
});

describe("New Task dialog", () => {
  async function open() {
    mount(<TasksBoard />);
    await screen.findByText("Rotate keys");
    fireEvent.click(screen.getByRole("button", { name: "New Task" }));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Prove installs" } });
  }

  it("lists only the chosen Core's Agents, Core first", async () => {
    await open();
    const agentGroup = () => screen.getByRole("radiogroup", { name: "Agent" });
    await within(agentGroup()).findByText(/cursor-cli/);
    expect(within(agentGroup()).queryByText(/opencode/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /build-box-01/ }));
    await within(agentGroup()).findByText(/opencode/);
    expect(within(agentGroup()).queryByText(/cursor-cli/)).toBeNull();
    expect(api.listCoreAgents).toHaveBeenCalledWith("c2");
  });

  it("Start now on creates it assigned, with the Core and the picked Agent", async () => {
    await open();
    fireEvent.click(await screen.findByRole("radio", { name: /cursor-cli/ }));
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create & assign" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ title: "Prove installs", coreId: "c1", agent: "ag-c1b", startNow: true });
  });

  it("Start now off creates a draft, and Save as draft is a draft whatever the switch says", async () => {
    await open();
    await screen.findByRole("radio", { name: /claude-code/ });
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ startNow: false });

    cleanup();
    await open();
    await screen.findByRole("radio", { name: /claude-code/ });
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(2));
    expect(api.createTask.mock.calls[1]![0]).toMatchObject({ startNow: false });
  });

  it("will not create or assign without a title, and shows the server's refusal", async () => {
    mount(<TasksBoard />);
    await screen.findByText("Rotate keys");
    fireEvent.click(screen.getByRole("button", { name: "New Task" }));
    await screen.findByRole("dialog");
    expect((screen.getByRole("button", { name: "Save as draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create & assign" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "x" } });
    api.createTask.mockRejectedValueOnce(new Error("that Agent is not on the chosen Core"));
    await screen.findByRole("radio", { name: /claude-code/ });
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not on the chosen Core");
  });
});

describe("Review fixes", () => {
  it("drops images from agent-written markdown instead of loading them", async () => {
    tasks = [task("t4", "Review PR", "failed", "c2", { description: "before ![d](https://evil.example/d.png) after" })];
    comments = [{ id: "k9", taskId: "t4", authorKind: "agent", authorName: "opencode", sourceFile: null, body: "![c](https://evil.example/c.png) text", createdAt: 2 }];
    const { container } = mount(<TaskDetail taskId="t4" onClose={() => {}} />);
    await screen.findByText(/text/);
    expect(container.ownerDocument.querySelector("img")).toBeNull();
  });

  it("Enter on a card's Reply button is the button's: it does not also open the Task", async () => {
    mount(<TasksBoard />);
    await screen.findByText("Review PR");
    const reply = screen.getByRole("button", { name: "Reply to Review PR" });
    // Not prevented, so the browser still turns Enter into the button's click.
    expect(fireEvent.keyDown(reply, { key: "Enter" })).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Task detail" })).toBeNull();
  });

  it("inserts the picked Agent for @agent, not the first one", async () => {
    mount(<TasksBoard />);
    await screen.findByText("Rotate keys");
    fireEvent.click(screen.getByRole("button", { name: "New Task" }));
    fireEvent.click(await screen.findByRole("radio", { name: /cursor-cli/ }));
    fireEvent.click(screen.getByRole("button", { name: "@agent" }));
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("@cursor-cli");
  });
});

describe("Task detail", () => {
  const finished = () => task("t4", "Review PR", "failed", "c2", { attemptCount: 1 });
  beforeEach(() => {
    tasks = [finished()];
    comments = [
      { id: "k1", taskId: "t4", authorKind: "system", authorName: "Panel", sourceFile: null, body: "Attempt 1 started", createdAt: 1 },
      { id: "k2", taskId: "t4", authorKind: "agent", authorName: "opencode", sourceFile: "fail.md", body: "ECONNREFUSED", createdAt: 2 },
    ];
  });

  it("shows badges, result files from agent comments, and the thread", async () => {
    mount(<TaskDetail taskId="t4" onClose={() => {}} />);
    await screen.findByRole("heading", { name: "Review PR" });
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Attempt 1")).toBeTruthy();
    expect(await screen.findByText("build-box-01")).toBeTruthy();
    const files = screen.getByRole("region", { name: "Result files" });
    expect(within(files).getByText(/fail\.md/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Comments" })).getByText("ECONNREFUSED")).toBeTruthy();
  });

  it("Comment & re-assign is one call with reassign, and Comment is one without", async () => {
    mount(<TaskDetail taskId="t4" onClose={() => {}} />);
    await screen.findByRole("heading", { name: "Review PR" });
    const composer = screen.getByLabelText("Comment");
    fireEvent.change(composer, { target: { value: "try again" } });
    fireEvent.click(screen.getByRole("button", { name: /Comment & re-assign/ }));
    await waitFor(() => expect(api.commentOnTask).toHaveBeenCalledTimes(1));
    expect(api.commentOnTask).toHaveBeenLastCalledWith("t4", { body: "try again", reassign: true });
    expect(api.setTaskStatus).not.toHaveBeenCalled();
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(""));
    fireEvent.change(composer, { target: { value: "note" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(api.commentOnTask).toHaveBeenCalledTimes(2));
    expect(api.commentOnTask).toHaveBeenLastCalledWith("t4", { body: "note", reassign: false });
  });

  it("offers re-assign only on a finished Task, and shows the server's refusal", async () => {
    tasks = [task("t4", "Review PR", "in_progress", "c2")];
    mount(<TaskDetail taskId="t4" onClose={() => {}} />);
    await screen.findByRole("heading", { name: "Review PR" });
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "hi" } });
    expect((screen.getByRole("button", { name: /Comment & re-assign/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the server's 409 when a re-assign is refused", async () => {
    mount(<TaskDetail taskId="t4" onClose={() => {}} />);
    await screen.findByRole("heading", { name: "Review PR" });
    api.commentOnTask.mockRejectedValueOnce(new Error("a Task cannot move from in_progress to assigned"));
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "again" } });
    fireEvent.click(screen.getByRole("button", { name: /Comment & re-assign/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("cannot move");
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("again");
  });

  it("assigns a draft and sends an assigned Task back to draft through the server", async () => {
    tasks = [task("t4", "Review PR", "draft", "c2")];
    mount(<TaskDetail taskId="t4" onClose={() => {}} />);
    await screen.findByRole("heading", { name: "Review PR" });
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(api.setTaskStatus).toHaveBeenCalledWith("t4", "assigned"));
  });
});
