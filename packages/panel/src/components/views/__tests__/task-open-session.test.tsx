// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import { formatTaskDispatchComment } from "~/shared/tasks";
import type { TaskCommentDto, TaskDto } from "~/shared/task-wire";

// Open session on a Task attempt (#676): pending-open + workspace navigate, same path as the Core page.

const navigate = vi.hoisted(() => vi.fn());
const requestSessionOpen = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate }),
}));
vi.mock("~/lib/session-notification-store", () => ({ requestSessionOpen }));

const cores = vi.hoisted((): CoreWithDial[] => [
  {
    id: "core_a",
    endpoint: "wss://x",
    label: "workstation-berlin",
    lastEventId: 0,
    createdAt: 0,
    updatedAt: 0,
    dial: { coreId: "core_a", state: "connected", lastSeenAt: 1 },
  },
]);
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({
    cores,
    fleet: { rows: [], offlineCores: [], singleCore: false },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

type SessionRow = { sessionId: string; title: string; agent: string; status: string; archived?: boolean };
const sessionRows = vi.hoisted(() => ({ rows: [] as SessionRow[] }));
const archivedRows = vi.hoisted(() => ({ rows: [] as SessionRow[] }));
vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({
    listSessionRows: async () => ({ sessions: sessionRows.rows, archivedCount: archivedRows.rows.length }),
    listArchivedSessions: async () => archivedRows.rows,
  }),
}));

let task: TaskDto;
let comments: TaskCommentDto[];
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  getTask: vi.fn(),
  listCoreAgents: vi.fn(async () => ({ agents: [] })),
  commentOnTask: vi.fn(),
  setTaskStatus: vi.fn(),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { TaskDetail } = await import("../TaskDetail");

function dispatchComment(attempt: number, sessionId: string, coreId = "core_a"): TaskCommentDto {
  return {
    id: `k-${attempt}`,
    taskId: "T-0142",
    authorKind: "system",
    authorName: "Panel",
    sourceFile: null,
    body: formatTaskDispatchComment({
      attempt,
      agentName: "OpenCode",
      harness: "opencode",
      coreId,
      sessionId,
    }),
    createdAt: attempt,
  };
}

function mount() {
  api.getTask.mockResolvedValue({ task, comments });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <TaskDetail taskId="T-0142" onClose={onClose} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
  return onClose;
}

beforeEach(() => {
  cores.length = 0;
  cores.push({
    id: "core_a",
    endpoint: "wss://x",
    label: "workstation-berlin",
    lastEventId: 0,
    createdAt: 0,
    updatedAt: 0,
    dial: { coreId: "core_a", state: "connected", lastSeenAt: 1 },
  });
  sessionRows.rows = [{ sessionId: "t-alive", title: "attempt", agent: "opencode", status: "running" }];
  archivedRows.rows = [];
  task = {
    id: "T-0142",
    title: "Rotate keys",
    description: "",
    status: "failed",
    coreId: "core_a",
    agent: "ag-1",
    attemptCount: 1,
    dispatchedAt: 1,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
  comments = [dispatchComment(1, "t-alive")];
  navigate.mockClear();
  requestSessionOpen.mockClear();
});
afterEach(cleanup);

describe("Open session on a Task attempt", () => {
  it("opens the Session with the Core page's pending-open path and closes the drawer", async () => {
    const onClose = mount();
    const button = (await screen.findByRole("button", { name: /Open session/ })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(requestSessionOpen).toHaveBeenCalledWith("core_a", "t-alive");
    expect(navigate).toHaveBeenCalledWith({ to: "/cores/$coreId/workspace", params: { coreId: "core_a" } });
    expect(onClose).toHaveBeenCalled();
  });

  it("disables the control with a reason when the Session is gone", async () => {
    sessionRows.rows = [];
    mount();
    const button = (await screen.findByRole("button", { name: /Open session/ })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(screen.getByText("Session no longer exists on this Core")).toBeTruthy();
    fireEvent.click(button);
    expect(requestSessionOpen).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("disables the control with a reason when the Core is gone", async () => {
    cores.length = 0;
    mount();
    const button = (await screen.findByRole("button", { name: /Open session/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("This Core is gone")).toBeTruthy();
    fireEvent.click(button);
    expect(requestSessionOpen).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("disables the control from dial state when the Core is not reachable", async () => {
    cores[0]!.dial = { coreId: "core_a", state: "unreachable", lastSeenAt: 1 };
    mount();
    const button = (await screen.findByRole("button", { name: /Open session/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("This Core is not reachable right now")).toBeTruthy();
    fireEvent.click(button);
    expect(requestSessionOpen).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("names an archived Session instead of saying it no longer exists", async () => {
    sessionRows.rows = [];
    archivedRows.rows = [{ sessionId: "t-alive", title: "attempt", agent: "opencode", status: "idle", archived: true }];
    mount();
    const button = (await screen.findByRole("button", { name: /Open session/ })) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText("Session is archived")).toBeTruthy());
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(requestSessionOpen).not.toHaveBeenCalled();
  });

  it("shows one Open session control per dispatched attempt", async () => {
    sessionRows.rows = [
      { sessionId: "t-one", title: "a1", agent: "opencode", status: "idle" },
      { sessionId: "t-two", title: "a2", agent: "opencode", status: "running" },
    ];
    task = { ...task, attemptCount: 2 };
    comments = [dispatchComment(1, "t-one"), dispatchComment(2, "t-two")];
    mount();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Open session/ })).toHaveLength(2));
  });
});
