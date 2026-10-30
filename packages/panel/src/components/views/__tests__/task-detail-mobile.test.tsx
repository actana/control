// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import { formatTaskDispatchComment, type TaskStatus } from "~/shared/tasks";
import type { TaskCommentDto, TaskDto } from "~/shared/task-wire";

// Task detail on a phone (#834, M42/M43): full screen page, pinned composer, Stop Task? as a bottom sheet.

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
  updateTask: vi.fn(),
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
  const task: TaskDto = { id: "T-7", title: "Rotate keys", description: "", status, coreId: "core_a", agent: null, attemptCount: opts.attemptCount ?? 1, dispatchedAt: 1, lastError: null, timeoutMinutes: 60, createdAt: 1, updatedAt: 1 };
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


function stubMatchMedia(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    };
  });
}

beforeEach(() => {
  cores.length = 0;
  cores.push({ id: "core_a", endpoint: "wss://x", label: "berlin", lastEventId: 0, createdAt: 0, updatedAt: 0, dial: { coreId: "core_a", state: "connected", lastSeenAt: 1 } });
  stubMatchMedia(390);
  api.stopTask.mockResolvedValue({ task: {}, session: null });
  api.commentOnTask.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function stubVisualViewport(initial: { height: number; offsetTop: number }) {
  const vv = Object.assign(new EventTarget(), initial);
  vi.stubGlobal("visualViewport", vv);
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return vv;
}

async function open(status: TaskStatus = "in_progress") {
  mount(status);
  await screen.findByRole("heading", { name: "Rotate keys" });
}

describe("Task detail on a phone", () => {
  it("is a full screen page with a back button and the title in the top bar", async () => {
    await open();
    const page = screen.getByRole("dialog", { name: "Task detail" });
    expect(page.hasAttribute("data-task-detail-page")).toBe(true);
    expect(screen.queryByTestId("task-detail-backdrop")).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(within(page).getAllByText("Rotate keys").length).toBeGreaterThan(1);
  });

  it("sizes the page to the visual viewport so the pinned composer stays above the keyboard", async () => {
    stubVisualViewport({ height: 420, offsetTop: 30 });
    await open();
    const page = document.querySelector("[data-task-detail-page]") as HTMLElement;
    expect(page.style.height).toBe("420px");
    expect(page.style.top).toBe("30px");
  });

  it("the Stop Task? sheet follows the visual viewport so Stop Task stays above the keyboard", async () => {
    stubVisualViewport({ height: 420, offsetTop: 0 });
    await open();
    fireEvent.click(screen.getByRole("button", { name: /^Stop$/ }));
    await screen.findByRole("dialog", { name: "Stop Task?" });
    expect(screen.getByTestId("bottom-sheet-backdrop").style.height).toBe("420px");
  });

  it("keeps the composer in a pinned footer outside the scrolling body", async () => {
    await open();
    const footer = screen.getByTestId("task-detail-composer");
    expect(within(footer).getByLabelText("Comment")).toBeTruthy();
    expect(screen.getByTestId("task-detail-body").contains(footer)).toBe(false);
  });

  it("sends a Comment from the pinned composer", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "note" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(api.commentOnTask).toHaveBeenCalledWith("T-7", { body: "note", reassign: false }));
  });

  it("sends Comment & re-assign for a finished Task", async () => {
    await open("failed");
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "retry" } });
    fireEvent.click(screen.getByRole("button", { name: /Comment & re-assign/ }));
    await waitFor(() => expect(api.commentOnTask).toHaveBeenCalledWith("T-7", { body: "retry", reassign: true }));
  });

  it("opens Stop Task? as a bottom sheet and stops with the optional reason", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /^Stop$/ }));
    const sheet = await screen.findByRole("dialog", { name: "Stop Task?" });
    expect(sheet.className).toContain("mc-bottom-sheet");
    fireEvent.change(within(sheet).getByLabelText(/Reason/), { target: { value: "wrong cohort exports" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Stop Task" }));
    await waitFor(() => expect(api.stopTask).toHaveBeenCalledWith("T-7", { reason: "wrong cohort exports" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Stop Task?" })).toBeNull());
  });

  it("stops with no reason when the field is empty", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /^Stop$/ }));
    const sheet = await screen.findByRole("dialog", { name: "Stop Task?" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Stop Task" }));
    await waitFor(() => expect(api.stopTask).toHaveBeenCalledWith("T-7", {}));
  });

  it("closes the sheet with Cancel without calling the api", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /^Stop$/ }));
    const sheet = await screen.findByRole("dialog", { name: "Stop Task?" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Stop Task?" })).toBeNull();
    expect(api.stopTask).not.toHaveBeenCalled();
  });

  it("closes the sheet with Escape and keeps the detail open", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /^Stop$/ }));
    await screen.findByRole("dialog", { name: "Stop Task?" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Stop Task?" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Task detail" })).toBeTruthy();
    expect(api.stopTask).not.toHaveBeenCalled();
  });

  it("edits and saves the title", async () => {
    api.updateTask.mockResolvedValue({});
    await open("assigned");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Rotate all keys" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith("T-7", { title: "Rotate all keys", description: "" }));
  });
});

describe("Task detail on desktop", () => {
  it("keeps the drawer and the Stop ConfirmDialog", async () => {
    stubMatchMedia(1280);
    await open();
    expect(screen.getByTestId("task-detail-backdrop")).toBeTruthy();
    expect(screen.queryByTestId("task-detail-composer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Stop$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Stop Task?" });
    expect(dialog.className).not.toContain("mc-bottom-sheet");
    expect(within(dialog).getByRole("button", { name: "Stop" })).toBeTruthy();
  });
});
