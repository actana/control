// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { TaskDto } from "~/shared/task-wire";

// Open folder on a Task (#565, deferred by #571's UI): it jumps to `tasks/<task id>` in the Task's Core's Files tab.

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (orig) => ({ ...(await orig<typeof import("@tanstack/react-router")>()), useRouter: () => ({ navigate }) }));
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores: [], fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));

let task: TaskDto;
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  getTask: vi.fn(),
  listCoreAgents: vi.fn(async () => ({ agents: [] })),
  commentOnTask: vi.fn(),
  setTaskStatus: vi.fn(),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { TaskDetail } = await import("../TaskDetail");

function mount(coreId: string | null, onClose = vi.fn(), focusComposer = false) {
  task = { id: "T-0142", title: "Rotate keys", description: "", status: "assigned", coreId, agent: null, attemptCount: 0, dispatchedAt: null, lastError: null, createdAt: 1, updatedAt: 1 };
  api.getTask.mockResolvedValue({ task, comments: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <TaskDetail taskId="T-0142" onClose={onClose} focusComposer={focusComposer} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
  return onClose;
}
afterEach(() => {
  cleanup();
  navigate.mockClear();
});

describe("Open folder on a Task", () => {
  it("jumps to the Task's folder in its Core's Files tab and closes the drawer", async () => {
    const onClose = mount("c1");
    fireEvent.click(await screen.findByRole("button", { name: /Open folder/ }));
    expect(navigate).toHaveBeenCalledWith({ to: "/cores/$coreId", params: { coreId: "c1" }, search: { tab: "files", path: "tasks/T-0142" } });
    expect(onClose).toHaveBeenCalled();
  });

  it("is off for a Task that has no Core yet", async () => {
    mount(null);
    const button = (await screen.findByRole("button", { name: /Open folder/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("Closing the Task drawer", () => {
  it("clears the app top bar, closes on a backdrop click and on Escape, and shows a Close button", async () => {
    const bar = document.createElement("div");
    bar.className = "mc-topbar";
    bar.getBoundingClientRect = () => ({ bottom: 48 }) as DOMRect;
    document.body.appendChild(bar);
    try {
      const onClose = mount("c1");
      const drawer = await screen.findByRole("dialog", { name: "Task detail" });
      expect(drawer.style.top).toBe("48px");
      expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
      fireEvent.click(screen.getByTestId("task-detail-backdrop"));
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(document.body, { key: "a" });
      expect(onClose).toHaveBeenCalledTimes(2);
    } finally {
      bar.remove();
    }
  });
});

describe("Task drawer focus and dismissal", () => {
  it("moves focus into the drawer on open, keeps Tab inside, and returns focus to the opener on close", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    try {
      mount("c1");
      const drawer = await screen.findByRole("dialog", { name: "Task detail" });
      expect(drawer.getAttribute("aria-modal")).toBe("true");
      expect(document.activeElement).toBe(drawer);
      // Shift+Tab from the drawer itself wraps to the last control; Tab from the last wraps to the first.
      fireEvent.keyDown(drawer, { key: "Tab", shiftKey: true });
      const last = document.activeElement as HTMLElement;
      expect(drawer.contains(last) && last !== drawer).toBe(true);
      fireEvent.keyDown(last, { key: "Tab" });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
      cleanup();
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
  });

  it("leaves focus to the composer when it autofocuses", async () => {
    mount("c1", vi.fn(), true);
    const drawer = await screen.findByRole("dialog", { name: "Task detail" });
    await waitFor(() => expect(document.activeElement?.tagName).toBe("TEXTAREA"));
    expect(drawer.contains(document.activeElement)).toBe(true);
  });

  it("ignores Escape during IME composition, and does not close on Escape or backdrop with an unsent draft", async () => {
    const onClose = mount("c1");
    await screen.findByRole("dialog", { name: "Task detail" });
    fireEvent.keyDown(document.body, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByRole("textbox", { name: "Comment" }), { target: { value: "half-written" } });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByTestId("task-detail-backdrop"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("follows the top bar when the window is resized", async () => {
    let bottom = 48;
    const bar = document.createElement("div");
    bar.className = "mc-topbar";
    bar.getBoundingClientRect = () => ({ bottom }) as DOMRect;
    document.body.appendChild(bar);
    try {
      mount("c1");
      const drawer = await screen.findByRole("dialog", { name: "Task detail" });
      expect(drawer.style.top).toBe("48px");
      bottom = 72;
      fireEvent(window, new Event("resize"));
      await waitFor(() => expect(drawer.style.top).toBe("72px"));
    } finally {
      bar.remove();
    }
  });
});
