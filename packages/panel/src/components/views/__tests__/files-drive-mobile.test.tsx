// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import type { SharedFileEntry } from "~/shared/shared-files";

// The Files tab on a phone (#833, M24–M26) against the same faked API as files-drive.test.tsx: what is asserted is what the tab asks the Panel for, what it shows of the
// answer, and that it never puts a key or an S3 address on the page. The Panel's own routes are tested on their own.

const NOW = Date.now();
const file = (path: string, size: number, extra: Partial<SharedFileEntry> = {}): SharedFileEntry => ({
  path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file", size, modifiedAt: NOW - 12_000, ...extra,
});
const folder = (path: string, itemCount: number): SharedFileEntry => ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind: "folder", itemCount });

const tree: Record<string, SharedFileEntry[]> = {
  "": [folder("sessions", 14), folder("uploads", 3), file("readme.md", 3482)],
  sessions: [folder("sessions/t-munykjig", 2), file("sessions/home.png", 84 * 1024), file("sessions/attempt-1.log", 118 * 1024)],
  "sessions/t-munykjig": [file("sessions/t-munykjig/report-1.md", 3482)],
  uploads: [],
};

const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  listSharedFiles: vi.fn(),
  getSharedFileDetails: vi.fn(),
  searchSharedFiles: vi.fn(),
  getSharedFilesSummary: vi.fn(),
  sharedFileDownloadUrl: vi.fn(),
  makeSharedFolder: vi.fn(),
  renameSharedFile: vi.fn(),
  moveSharedFile: vi.fn(),
  deleteSharedFile: vi.fn(),
}));
vi.mock("~/lib/api", () => ({
  api,
  ApiError: class extends Error {},
  sharedFileMediaUrl: (c: string, p: string) => `/api/cores/${c}/shared/files/media?path=${encodeURIComponent(p)}`,
  sharedFileUploadUrl: (c: string, p: string) => `/api/cores/${c}/shared/files/upload?path=${encodeURIComponent(p)}`,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { FilesDrive } = await import("../FilesDrive");
const { filesDrive } = await import("~/lib/files-drive-store");

function core(state: "connected" | "unreachable" = "connected", folderState: "attached" | "pending" | null = "attached"): CoreWithDial {
  return {
    id: "c1", endpoint: "wss://x", label: "workstation-berlin", lastEventId: 0, createdAt: 0, updatedAt: 0,
    dial: { coreId: "c1", state, lastSeenAt: NOW - 180_000 } as CoreWithDial["dial"],
    ...(folderState ? { sharedFolder: { state: folderState, prefix: "cores/c1/", keyExpiresAt: null, error: null } } : {}),
  } as CoreWithDial;
}

class FakeXhr {
  static sent: { method: string; url: string; size: number }[] = [];
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 200;
  responseText = "{}";
  withCredentials = false;
  private method = "";
  private url = "";
  open(method: string, url: string) { this.method = method; this.url = url; }
  send(body: File) {
    FakeXhr.sent.push({ method: this.method, url: this.url, size: body.size });
    this.upload.onprogress?.({ loaded: body.size });
    queueMicrotask(() => this.onload?.());
  }
}

let width = 390;
function stubWidth() {
  // jsdom has no matchMedia (= desktop); the breakpoint hooks read max-width queries against this width.
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return { media: query, matches: max ? width <= Number(max[1]) : false, addEventListener: () => {}, removeEventListener: () => {} };
  });
}

let path = "";
function mount(c: CoreWithDial = core(), initial = "") {
  path = initial;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPath = vi.fn((p: string) => { path = p; view.rerender(ui()); });
  const ui = () => (
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <FilesDrive core={c} path={path} onPath={onPath} />
      </KeybindingsProvider>
    </QueryClientProvider>
  );
  const view = render(ui());
  return { onPath, client };
}

beforeEach(() => {
  width = 390;
  stubWidth();
  filesDrive.reset();
  FakeXhr.sent = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  localStorage.clear();
  api.listSharedFiles.mockImplementation(async (_c: string, p: string) => ({ path: p, entries: tree[p.replace(/\/+$/, "")] ?? [] }));
  api.getSharedFileDetails.mockImplementation(async (_c: string, p: string) => {
    const entry = Object.values(tree).flat().find((e) => e.path === p)!;
    return { links: { pullRequests: [] }, entry, preview: p.endsWith(".md") ? { kind: "markdown", text: "# impl report\nPR 581", truncated: false } : p.endsWith(".png") ? { kind: "image" } : { kind: "log", text: "$ run\nok", truncated: true } };
  });
  api.getSharedFilesSummary.mockResolvedValue({ backend: "SeaweedFS", usedBytes: 412 * 1024 * 1024, fileCount: 20, newPaths: ["sessions/t-munykjig/report-1.md"], uploadLimitBytes: 1000 });
  api.searchSharedFiles.mockResolvedValue({ query: "rep", entries: [file("sessions/t-munykjig/report-1.md", 3482)], truncated: false });
  api.sharedFileDownloadUrl.mockResolvedValue({ url: "http://s3.test/b/p?X-Amz-Expires=300", expiresAt: NOW + 300_000 });
  api.makeSharedFolder.mockResolvedValue({ path: "x" });
  api.renameSharedFile.mockImplementation(async (_c: string, p: string, name: string) => ({ path: `${p.replace(/[^/]*\/?$/, "")}${name}` }));
  api.moveSharedFile.mockResolvedValue({ path: "uploads/report-1.md" });
  api.deleteSharedFile.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});


describe("the Files tab on a phone", () => {
  it("M24: breadcrumb, search, New and Grid/List on top; no tree; storage used under the folder", async () => {
    mount(core(), "sessions");
    expect(await screen.findByText("attempt-1.log")).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: /Shared folder/ })).toBeNull();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect(within(crumbs).getByText("sessions").getAttribute("aria-current")).toBe("page");
    expect(within(crumbs).queryByRole("button", { name: "Rename this folder" })).toBeNull();
    expect(screen.getByRole("button", { name: "Folder actions" })).toBeTruthy();
    expect(screen.getByLabelText("Search in Shared folder")).toBeTruthy();
    const views = screen.getByRole("group", { name: "View" });
    expect(within(views).getByRole("button", { name: /Grid/ })).toBeTruthy();
    expect(within(views).getByRole("button", { name: /List/ })).toBeTruthy();
    expect(await screen.findByText("412 MB used · SeaweedFS")).toBeTruthy();
  });

  it("M24 list: folders and files as rows in two cards, with counts, sizes and new badges", async () => {
    mount(core(), "");
    await screen.findByText("readme.md");
    fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: /List/ }));
    const folders = await screen.findByRole("region", { name: "Folders" });
    expect(screen.queryByRole("table", { name: "Files" })).toBeNull();
    await waitFor(() => expect(within(folders).getAllByRole("button").map((b) => b.textContent)).toContain("sessions14 items · new"));
    expect(within(folders).getByRole("button", { name: /New folder/ })).toBeTruthy();
    const files = screen.getByRole("region", { name: "Files" });
    expect(within(files).getByRole("button", { name: /readme\.md\s*3\.4 KB/ })).toBeTruthy();
  });

  it("M24 list: a folder row opens the folder, the breadcrumb walks back up", async () => {
    const { onPath } = mount();
    filesDrive.setView("list");
    fireEvent.click(await screen.findByRole("button", { name: /sessions\s*14 items/ }));
    expect(onPath).toHaveBeenCalledWith("sessions");
    await screen.findByText("attempt-1.log");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumbs" })).getByRole("button", { name: "Shared folder" }));
    expect(onPath).toHaveBeenLastCalledWith("");
  });

  it("M25: a tapped file opens full screen with Back, its details and Download / Copy path / Rename / Move / Delete", async () => {
    mount(core(), "sessions/t-munykjig");
    filesDrive.setView("list");
    fireEvent.click(await screen.findByRole("button", { name: /report-1\.md/ }));
    const screenEl = await screen.findByRole("dialog", { name: "File report-1.md" });
    expect(within(screenEl).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(await within(screenEl).findByText("Path")).toBeTruthy();
    expect(within(screenEl).getByText("shared/sessions/t-munykjig/report-1.md")).toBeTruthy();
    const actions = within(screenEl).getByTestId("file-actions");
    for (const name of ["Download", "Copy path", "Rename", "Move", "Delete"]) expect(within(actions).getByRole("button", { name })).toBeTruthy();
    await waitFor(() => expect((within(actions).getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(actions).getByRole("button", { name: "Download" }));
    await waitFor(() => expect(api.sharedFileDownloadUrl).toHaveBeenCalledWith("c1", "sessions/t-munykjig/report-1.md"));
    fireEvent.click(within(screenEl).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog", { name: "File report-1.md" })).toBeNull();
    expect(screen.getByText("report-1.md")).toBeTruthy();
  });

  it("M25: Escape goes back to the folder", async () => {
    mount(core(), "sessions/t-munykjig");
    fireEvent.click(await screen.findByRole("button", { name: /report-1\.md/ }));
    const screenEl = await screen.findByRole("dialog", { name: "File report-1.md" });
    fireEvent.keyDown(within(screenEl).getByRole("button", { name: "Back" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "File report-1.md" })).toBeNull();
  });

  it("M25: Rename from the opened file is a full-screen sheet whose header action submits it", async () => {
    mount(core(), "sessions/t-munykjig");
    filesDrive.setView("list");
    fireEvent.click(await screen.findByRole("button", { name: /report-1\.md/ }));
    const screenEl = await screen.findByRole("dialog", { name: "File report-1.md" });
    const rename = within(within(screenEl).getByTestId("file-actions")).getByRole("button", { name: "Rename" }) as HTMLButtonElement;
    await waitFor(() => expect(rename.disabled).toBe(false));
    fireEvent.click(rename);
    const sheet = await screen.findByRole("dialog", { name: "Rename file" });
    expect(sheet.hasAttribute("data-full-screen-sheet")).toBe(true);
    fireEvent.change(within(sheet).getByDisplayValue("report-1.md"), { target: { value: "final.md" } });
    fireEvent.click(sheet.querySelector(".mc-sheet-header .mc-sheet-action-primary") as HTMLElement);
    await waitFor(() => expect(api.renameSharedFile).toHaveBeenCalledWith("c1", "sessions/t-munykjig/report-1.md", "final.md"));
  });

  it("M25: Delete from the opened file asks, deletes and goes back to the folder", async () => {
    mount(core(), "sessions/t-munykjig");
    fireEvent.click(await screen.findByRole("button", { name: /report-1\.md/ }));
    const screenEl = await screen.findByRole("dialog", { name: "File report-1.md" });
    const del = within(within(screenEl).getByTestId("file-actions")).getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    await waitFor(() => expect(del.disabled).toBe(false));
    fireEvent.click(del);
    const confirm = await screen.findByRole("dialog", { name: "Delete this file?" });
    fireEvent.click(within(confirm).getByRole("button", { name: /Delete/ }));
    await waitFor(() => expect(api.deleteSharedFile).toHaveBeenCalledWith("c1", "sessions/t-munykjig/report-1.md"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "File report-1.md" })).toBeNull());
  });

  it("M26: + New opens a bottom action sheet with the four actions and Cancel", async () => {
    mount();
    await screen.findByText("readme.md");
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    const sheet = screen.getByRole("dialog", { name: "New" });
    expect(within(sheet).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["New folder", "Upload files", "Upload folder", "New text file"]);
    expect(document.activeElement).toBe(within(sheet).getAllByRole("menuitem")[0]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New" })).toBeNull();
  });

  it("M26: New folder from the sheet opens a full-screen form that creates the folder", async () => {
    mount(core(), "uploads");
    await waitFor(() => expect(api.listSharedFiles).toHaveBeenCalledWith("c1", "uploads"));
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "New" })).getByRole("menuitem", { name: "New folder" }));
    expect(screen.queryByRole("dialog", { name: "New" })).toBeNull();
    const form = await screen.findByRole("dialog", { name: "New folder" });
    expect(form.hasAttribute("data-full-screen-sheet")).toBe(true);
    fireEvent.change(within(form).getByLabelText("Folder name"), { target: { value: "q3" } });
    fireEvent.click(form.querySelector(".mc-sheet-header .mc-sheet-action-primary") as HTMLElement);
    await waitFor(() => expect(api.makeSharedFolder).toHaveBeenCalledWith("c1", "uploads/q3/"));
  });

  it("M26: Upload files from the sheet opens the file picker", async () => {
    mount();
    await screen.findByText("readme.md");
    const picker = screen.getByLabelText("Upload files") as HTMLInputElement;
    const click = vi.spyOn(picker, "click");
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "New" })).getByRole("menuitem", { name: "Upload files" }));
    expect(click).toHaveBeenCalled();
  });

  it("M26: the sheet closes on Escape and on a tap on the dimmed page", async () => {
    mount();
    await screen.findByText("readme.md");
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "New" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByTestId("action-sheet-backdrop"));
    expect(screen.queryByRole("dialog", { name: "New" })).toBeNull();
  });

  it("the open folder's Rename / Move / Delete are in a ⋯ action sheet", async () => {
    mount(core(), "sessions");
    await screen.findByText("attempt-1.log");
    fireEvent.click(screen.getByRole("button", { name: "Folder actions" }));
    const sheet = screen.getByRole("dialog", { name: "sessions" });
    expect(within(sheet).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Rename folder", "Move folder", "Delete folder"]);
    fireEvent.click(within(sheet).getByRole("menuitem", { name: "Delete folder" }));
    expect(await screen.findByRole("dialog", { name: "Delete this folder?" })).toBeTruthy();
  });

  it("has no ⋯ at the top of the Shared folder, which cannot be renamed", async () => {
    mount();
    await screen.findByText("readme.md");
    expect(screen.queryByRole("button", { name: "Folder actions" })).toBeNull();
  });

  it("M26: the Core-offline banner sits above the breadcrumb and the folder still lists", async () => {
    mount(core("unreachable"));
    const banner = await screen.findByText(/This Core is offline/);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect(banner.compareDocumentPosition(crumbs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByText("readme.md")).toBeTruthy();
  });

  it("search hits list as rows, not the desktop table", async () => {
    mount();
    await screen.findByText("readme.md");
    fireEvent.change(screen.getByLabelText("Search in Shared folder"), { target: { value: "rep" } });
    const files = await screen.findByRole("region", { name: "Files" });
    expect(await within(files).findByRole("button", { name: /report-1\.md/ })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Files" })).toBeNull();
  });

  it("a small tablet (800 px) gets the same one-column layout", async () => {
    width = 800;
    mount();
    await screen.findByText("readme.md");
    expect(screen.queryByRole("treeitem", { name: /Shared folder/ })).toBeNull();
    expect(screen.getByRole("group", { name: "View" })).toBeTruthy();
  });
});

describe("the Files tab on desktop", () => {
  it("is unchanged at 1280 px: tree, inline breadcrumb actions, drop-down New menu and the details pane", async () => {
    width = 1280;
    mount(core(), "sessions");
    expect(await screen.findByRole("treeitem", { name: /Shared folder/ })).toBeTruthy();
    await screen.findByText("attempt-1.log");
    expect(screen.queryByRole("group", { name: "View" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Folder actions" })).toBeNull();
    expect(screen.getByRole("button", { name: "Rename this folder" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "New" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("button", { name: /attempt-1\.log/ }));
    expect(await screen.findByRole("complementary", { name: "File details" })).toBeTruthy();
    expect(screen.queryByTestId("file-screen")).toBeNull();
    expect(screen.getByText(/Drop files or folders anywhere here/)).toBeTruthy();
  });
});
