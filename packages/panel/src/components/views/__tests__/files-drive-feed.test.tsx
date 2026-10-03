// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import type { SharedFileEntry } from "~/shared/shared-files";

// The Files tab on the Core's change feed (#561): "new" badges and live refresh come from `shared:changed` events on the
// panel link, and S3 is listed on a timer only while the Core is offline and the feed has nothing to say.

const NOW = Date.now();
const file = (path: string, size = 10): SharedFileEntry => ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file", size, modifiedAt: NOW - 60_000 });

const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  listSharedFiles: vi.fn(),
  getSharedFileDetails: vi.fn(),
  searchSharedFiles: vi.fn(),
  getSharedFilesSummary: vi.fn(),
  getTask: vi.fn(),
  listCoreAgents: vi.fn(),
}));
vi.mock("~/lib/api", () => ({
  api,
  ApiError: class extends Error {},
  sharedFileMediaUrl: (c: string, p: string) => `/m/${c}?path=${p}`,
  sharedFileUploadUrl: (c: string, p: string) => `/u/${c}?path=${p}`,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

type Listener = (m: { coreId: string; event: { eventId: number; kind: string; payload: string; ts: number } }) => void;
const bridge = vi.hoisted(() => ({
  listeners: new Set<unknown>(),
  connection: new Set<unknown>(),
  watched: [] as string[],
  released: [] as string[],
}));
vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({
    watchCore: (coreId: string) => {
      bridge.watched.push(coreId);
      return () => bridge.released.push(coreId);
    },
    onEvent: (cb: unknown) => (bridge.listeners.add(cb), () => bridge.listeners.delete(cb)),
    onConnectionChange: (cb: unknown) => (bridge.connection.add(cb), () => bridge.connection.delete(cb)),
    listSessionRows: async () => ({ sessions: [], archivedCount: 0 }),
  }),
}));

const { FilesDrive } = await import("../FilesDrive");
const { filesDrive } = await import("~/lib/files-drive-store");

function emit(kind: string, payload: Record<string, unknown> | string, coreId = "c1") {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const l of bridge.listeners) (l as Listener)({ coreId, event: { eventId: 1, kind, payload: body, ts: Date.now() } });
}

function core(state: "connected" | "unreachable"): CoreWithDial {
  return {
    id: "c1", endpoint: "wss://x", label: "ws", lastEventId: 0, createdAt: 0, updatedAt: 0,
    dial: { coreId: "c1", state, lastSeenAt: NOW } as CoreWithDial["dial"],
    sharedFolder: { state: "attached", prefix: "cores/c1/", keyExpiresAt: null, error: null },
  } as CoreWithDial;
}

function mount(c: CoreWithDial, initial = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <FilesDrive core={c} path={initial} onPath={vi.fn()} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}

let entries: SharedFileEntry[];
beforeEach(() => {
  filesDrive.reset();
  localStorage.clear();
  bridge.listeners.clear();
  bridge.connection.clear();
  bridge.watched = [];
  bridge.released = [];
  entries = [file("report.md")];
  api.listSharedFiles.mockImplementation(async (_c: string, p: string) => ({ path: p, entries: p === "" ? entries : [] }));
  api.getSharedFileDetails.mockImplementation(async (_c: string, p: string) => ({
    links: { pullRequests: [] },
    entry: entries.find((e) => e.path === p) ?? file(p),
    preview: { kind: "log", text: "x", truncated: false },
  }));
  api.getSharedFilesSummary.mockResolvedValue({ backend: "SeaweedFS", usedBytes: 10, fileCount: 1, newPaths: [], uploadLimitBytes: 1000 });
  api.searchSharedFiles.mockResolvedValue({ query: "", entries: [], truncated: false });
  api.getTask.mockRejectedValue(new Error("none"));
  api.listCoreAgents.mockResolvedValue({ agents: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const listings = () => api.listSharedFiles.mock.calls.filter((c) => c[1] === "").length;

describe("the new badge, from the change feed", () => {
  it("badges a file the Core writes while the tab is open, and no other", async () => {
    mount(core("connected"));
    await screen.findByText("report.md");
    expect(screen.queryByText(/· new/)).toBeNull();
    entries = [file("report.md", 20), file("fresh.log")];
    act(() => emit("shared:changed", { path: "fresh.log", size: 10, mtime: Date.now() + 1000, deleted: false }));
    expect(await screen.findByText("fresh.log")).toBeTruthy();
    const badges = await screen.findAllByText(/· new/);
    expect(badges).toHaveLength(1);
    expect(badges[0]!.closest("button")!.textContent).toContain("fresh.log");
  });

  it("does not badge a change older than the last visit", async () => {
    localStorage.setItem("mc:files-last-visit:c1", String(NOW));
    mount(core("connected"));
    await screen.findByText("report.md");
    act(() => emit("shared:changed", { path: "report.md", size: 10, mtime: NOW - 5_000, deleted: false }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/· new/)).toBeNull();
  });

  it("takes a badge away when the Core deletes the file, even one the opening listing called new", async () => {
    api.getSharedFilesSummary.mockResolvedValue({ backend: "SeaweedFS", usedBytes: 10, fileCount: 1, newPaths: ["report.md"], uploadLimitBytes: 1000 });
    mount(core("connected"));
    expect(await screen.findByText(/· new/)).toBeTruthy();
    act(() => emit("shared:changed", { path: "report.md", size: 0, mtime: Date.now() + 1000, deleted: true }));
    await waitFor(() => expect(screen.queryByText(/· new/)).toBeNull());
  });

  it("keeps the opening listing's badges for files written while no tab was open", async () => {
    api.getSharedFilesSummary.mockResolvedValue({ backend: "SeaweedFS", usedBytes: 10, fileCount: 1, newPaths: ["report.md"], uploadLimitBytes: 1000 });
    mount(core("connected"));
    expect(await screen.findByText(/· new/)).toBeTruthy();
  });

  it("ignores another Core's events, other event kinds, and a payload it cannot read", async () => {
    mount(core("connected"));
    await screen.findByText("report.md");
    act(() => {
      emit("shared:changed", { path: "report.md", size: 1, mtime: Date.now() + 1000, deleted: false }, "c2");
      emit("session:status", { path: "report.md", size: 1, mtime: Date.now() + 1000, deleted: false });
      emit("shared:changed", "not json");
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/· new/)).toBeNull();
  });

  it("watches this Core while the tab is open and lets go when it closes", async () => {
    const view = mount(core("connected"));
    await screen.findByText("report.md");
    expect(bridge.watched).toContain("c1");
    view.unmount();
    expect(bridge.released).toContain("c1");
    expect(bridge.listeners.size).toBe(0);
  });
});

describe("refreshing without polling", () => {
  it("does not list S3 on a timer while the Core is connected, and lists once after a burst of events", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount(core("connected"));
    await screen.findByText("report.md");
    const before = listings();
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    expect(listings()).toBe(before);
    expect(api.getSharedFilesSummary).toHaveBeenCalledTimes(1);

    entries = [file("report.md"), file("a.log"), file("b.log")];
    act(() => {
      emit("shared:changed", { path: "a.log", size: 1, mtime: Date.now(), deleted: false });
      emit("shared:changed", { path: "b.log", size: 1, mtime: Date.now(), deleted: false });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(listings()).toBe(before + 1);
    expect(await screen.findByText("b.log")).toBeTruthy();
  });

  it("falls back to listing S3 every ten seconds while the Core is offline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount(core("unreachable"));
    await screen.findByText("report.md");
    const before = listings();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    expect(listings()).toBeGreaterThan(before);
    expect(api.getSharedFilesSummary.mock.calls.length).toBeGreaterThan(1);
  });

  it("looks again when the link comes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount(core("connected"));
    await screen.findByText("report.md");
    const before = listings();
    act(() => { for (const cb of bridge.connection) (cb as (c: boolean) => void)(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(listings()).toBe(before + 1);
  });
});

describe("the sync state in the details pane", () => {
  it("follows the Core's last event for the selected file", async () => {
    mount(core("connected"));
    const card = await screen.findByText("report.md");
    act(() => card.closest("button")!.click());
    expect(await screen.findByText(/in storage$/)).toBeTruthy();
    act(() => emit("shared:changed", { path: "report.md", size: 10, mtime: Date.now(), deleted: false }));
    expect(await screen.findByText(/synced to S3/)).toBeTruthy();
    act(() => emit("shared:changed", { path: "report.md", size: 99, mtime: Date.now(), deleted: false }));
    expect(await screen.findByText(/syncing with the Core/)).toBeTruthy();
  });

  it("says why nothing more is known when the Core is offline", async () => {
    mount(core("unreachable"));
    const card = await screen.findByText("report.md");
    act(() => card.closest("button")!.click());
    expect(await screen.findByText(/in storage · Core not connected/)).toBeTruthy();
  });
});
