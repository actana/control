// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";

// New Task as a phone sheet (#834, M44/M45). matchMedia and the api are the edges.

const cores: CoreWithDial[] = [
  { id: "c1", endpoint: "wss://x", label: "berlin", lastEventId: 0, createdAt: 0, updatedAt: 0, dial: { coreId: "c1", state: "connected", lastSeenAt: 1 } },
  { id: "c2", endpoint: "wss://y", label: "paris", lastEventId: 0, createdAt: 0, updatedAt: 0, dial: { coreId: "c2", state: "unreachable", lastSeenAt: 1 } },
];
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores, fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  listTasks: vi.fn(async () => ({ tasks: [] })),
  listCoreAgents: vi.fn(async (coreId: string) => ({
    agents: [
      { id: `a1-${coreId}`, coreId, name: "claude-code", harness: "claude-code", model: null, isDefault: true },
      { id: `a2-${coreId}`, coreId, name: "codex", harness: "codex", model: "gpt", isDefault: false },
    ],
  })),
  createTask: vi.fn(async (_body: Record<string, unknown>) => ({ task: { id: "new" } })),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { NewTaskDialog } = await import("../NewTaskDialog");

function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return { media: query, matches: max ? width <= Number(max[1]) : false, addEventListener: () => {}, removeEventListener: () => {} };
  });
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <NewTaskDialog open onClose={vi.fn()} initialCoreId="c1" />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear();
  stubWidth(390);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("New Task on a phone", () => {
  it("is a full-screen sheet with Cancel, New Task and Create & assign", async () => {
    mount();
    const sheet = await screen.findByRole("dialog");
    expect(sheet.hasAttribute("data-full-screen-sheet")).toBe(true);
    const header = sheet.querySelector(".mc-sheet-header") as HTMLElement;
    expect(within(header).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(within(header).getByText("New Task")).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Create & assign" })).toBeTruthy();
    expect(sheet.querySelector(".mc-sheet-footer")?.textContent).toContain("Create & assign");
  });

  it("the header action says Create when Start as soon as it is created is off", async () => {
    mount();
    fireEvent.click(await screen.findByRole("switch", { name: "Start as soon as it is created" }));
    const header = screen.getByRole("dialog").querySelector(".mc-sheet-header") as HTMLElement;
    expect(within(header).getByRole("button", { name: "Create" })).toBeTruthy();
  });

  it("creates with the Core and Agent picked from the row lists", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Do it" } });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Core" })).getByRole("radio", { name: /paris · offline/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /codex/ }));
    const header = screen.getByRole("dialog").querySelector(".mc-sheet-header") as HTMLElement;
    fireEvent.click(within(header).getByRole("button", { name: "Create & assign" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalled());
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ title: "Do it", coreId: "c2", agent: "a2-c2", startNow: true });
  });

  it("marks an offline Core row as dimmed and keeps it selectable", async () => {
    mount();
    const offline = await screen.findByRole("radio", { name: /paris · offline/ });
    expect(offline.closest("[data-offline]")).not.toBeNull();
    expect(screen.getByRole("radio", { name: /berlin · online/ }).closest("[data-offline]")).toBeNull();
    fireEvent.click(offline);
    expect(offline.getAttribute("aria-checked")).toBe("true");
  });

  it("Save as draft creates a draft", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Later" } });
    await screen.findByRole("radio", { name: /claude-code/ });
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalled());
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ title: "Later", startNow: false });
  });

  it("selects a time limit chip", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "T" } });
    await screen.findByRole("radio", { name: /claude-code/ });
    fireEvent.click(screen.getByRole("radio", { name: /^4 hours/ }));
    expect(screen.getByRole("radio", { name: /^4 hours/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getAllByRole("button", { name: "Create & assign" })[1]!);
    await waitFor(() => expect(api.createTask.mock.calls[0]![0]).toMatchObject({ timeoutMinutes: 240 }));
  });
});

describe("New Task on desktop", () => {
  it("is still the centred dialog", async () => {
    stubWidth(1280);
    mount();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.hasAttribute("data-full-screen-sheet")).toBe(false);
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as draft" })).toBeTruthy();
  });
});
