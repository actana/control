// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import type { SharedFileEntry } from "~/shared/shared-files";

// The Files tab (#565) against a faked API: what is asserted is what the tab asks the Panel for, what it shows of the
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
  filesDrive.reset();
  FakeXhr.sent = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  localStorage.clear();
  api.listSharedFiles.mockImplementation(async (_c: string, p: string) => ({ path: p, entries: tree[p.replace(/\/+$/, "")] ?? [] }));
  api.getSharedFileDetails.mockImplementation(async (_c: string, p: string) => {
    const entry = Object.values(tree).flat().find((e) => e.path === p)!;
    return { entry, preview: p.endsWith(".md") ? { kind: "markdown", text: "# impl report\nPR 581", truncated: false } : p.endsWith(".png") ? { kind: "image" } : { kind: "log", text: "$ run\nok", truncated: true } };
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

describe("the Files tab", () => {
  it("shows the Shared folder: tree with counts, folder tiles with a New folder tile, files as cards, and storage used", async () => {
    mount();
    expect(await screen.findByRole("treeitem", { name: /Shared folder/ })).toBeTruthy();
    const folders = await screen.findByRole("region", { name: "Folders" });
    expect(within(folders).getByText("sessions")).toBeTruthy();
    expect(within(folders).getByText("14 items")).toBeTruthy();
    expect(within(folders).getByRole("button", { name: /New folder/ })).toBeTruthy();
    const files = screen.getByRole("region", { name: "Files" });
    expect(within(files).getByText("readme.md")).toBeTruthy();
    expect(await screen.findByText("412 MB used · SeaweedFS")).toBeTruthy();
    expect(api.listSharedFiles).toHaveBeenCalledWith("c1", "");
  });

  it("opens a folder from a tile with one shared path: breadcrumbs follow it and walk back up", async () => {
    const { onPath } = mount();
    fireEvent.click(await screen.findByRole("button", { name: /sessions\s*14 items/ }));
    expect(onPath).toHaveBeenCalledWith("sessions");
    expect(await screen.findByText("attempt-1.log")).toBeTruthy();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect(within(crumbs).getByText("sessions").getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(crumbs).getByRole("button", { name: "Shared folder" }));
    expect(onPath).toHaveBeenLastCalledWith("");
  });

  it("opens straight into a folder named by the path (a link from a Task) and lists exactly that folder", async () => {
    mount(core(), "sessions/t-munykjig");
    expect(await screen.findByText("report-1.md")).toBeTruthy();
    expect(api.listSharedFiles).toHaveBeenCalledWith("c1", "sessions/t-munykjig");
  });

  it("badges files written since the last visit as new, and a folder that holds one", async () => {
    mount(core(), "sessions/t-munykjig");
    await screen.findByText("report-1.md");
    expect(await screen.findByText(/· new/)).toBeTruthy();
    // The summary was asked since the stored last visit, not since 0.
    await waitFor(() => expect(api.getSharedFilesSummary).toHaveBeenCalled());
    const since = api.getSharedFilesSummary.mock.calls[0]![1] as number;
    expect(since).toBeGreaterThan(NOW - 5_000);
  });

  it("stamps the visit when the tab is left, so the next visit's badges start from it", async () => {
    const { client } = mount();
    await screen.findByText("readme.md");
    expect(localStorage.getItem("mc:files-last-visit:c1")).toBeNull();
    cleanup();
    client.clear();
    expect(Number(localStorage.getItem("mc:files-last-visit:c1"))).toBeGreaterThan(NOW - 5_000);
  });

  it("says so when the Core is offline, and still lists the folder", async () => {
    mount(core("unreachable"));
    expect(await screen.findByText(/This Core is offline/)).toBeTruthy();
    expect(screen.getByText(/read from storage\s+directly/)).toBeTruthy();
    expect(await screen.findByText("readme.md")).toBeTruthy();
  });

  it("has no banner for a Core that is online", async () => {
    mount();
    await screen.findByText("readme.md");
    expect(screen.queryByText(/This Core is offline/)).toBeNull();
  });

  it("asks for the pairing to be finished when the Core has no folder yet, and reads nothing", async () => {
    mount(core("connected", "pending"));
    expect(await screen.findByText("No Shared folder yet")).toBeTruthy();
    expect(api.listSharedFiles).not.toHaveBeenCalled();
  });

  it("switches between Grid and List and remembers the choice", async () => {
    mount();
    await screen.findByText("readme.md");
    fireEvent.click(screen.getByRole("button", { name: /List/ }));
    expect(await screen.findByRole("table", { name: "Files" })).toBeTruthy();
    expect(localStorage.getItem("mc:files-view")).toBe('"list"');
    fireEvent.click(screen.getByRole("button", { name: /Grid/ }));
    expect(await screen.findByRole("region", { name: "Folders" })).toBeTruthy();
  });

  it("searches the Shared folder and shows the hits", async () => {
    mount();
    await screen.findByText("readme.md");
    fireEvent.change(screen.getByLabelText("Search in Shared folder"), { target: { value: "rep" } });
    expect(await screen.findByText("report-1.md")).toBeTruthy();
    expect(api.searchSharedFiles).toHaveBeenCalledWith("c1", "rep");
  });
});

describe("the details pane", () => {
  async function select(name: string) {
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
    return await screen.findByRole("complementary", { name: "File details" });
  }

  it("shows the preview, path, size and when it changed, and a new file is marked", async () => {
    mount(core(), "sessions/t-munykjig");
    const pane = await select("report-1.md");
    expect(await within(pane).findByTestId("file-preview")).toBeTruthy();
    expect(within(pane).getByText(/# impl report/)).toBeTruthy();
    expect(within(pane).getByText("shared/sessions/t-munykjig/report-1.md")).toBeTruthy();
    expect(within(pane).getByText("3.4 KB")).toBeTruthy();
    expect(await within(pane).findByText("new")).toBeTruthy();
  });

  it("downloads through a URL the Panel mints for that one file, and follows it", async () => {
    const clicked: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicked.push(this.href); };
    try {
      mount(core(), "sessions/t-munykjig");
      const pane = await select("report-1.md");
      fireEvent.click(await within(pane).findByRole("button", { name: /Download/ }));
      await waitFor(() => expect(clicked).toEqual(["http://s3.test/b/p?X-Amz-Expires=300"]));
      expect(api.sharedFileDownloadUrl).toHaveBeenCalledWith("c1", "sessions/t-munykjig/report-1.md");
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
  });

  it("copies the path as it is on the machine", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount(core(), "sessions/t-munykjig");
    const pane = await select("report-1.md");
    fireEvent.click(await within(pane).findByRole("button", { name: /Copy path/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("shared/sessions/t-munykjig/report-1.md"));
  });

  it("renames, and the pane follows the file to its new name", async () => {
    mount(core(), "sessions/t-munykjig");
    const pane = await select("report-1.md");
    fireEvent.click(await within(pane).findByRole("button", { name: /Rename/ }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("report-1.md");
    fireEvent.change(input, { target: { value: "final.md" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(api.renameSharedFile).toHaveBeenCalledWith("c1", "sessions/t-munykjig/report-1.md", "final.md"));
    await waitFor(() => expect(filesDrive.get().selected).toBe("sessions/t-munykjig/final.md"));
  });

  it("refuses a name that is a path before asking the Panel", async () => {
    mount(core(), "sessions/t-munykjig");
    const pane = await select("report-1.md");
    fireEvent.click(await within(pane).findByRole("button", { name: /Rename/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "../x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(await within(dialog).findByText(/cannot contain/)).toBeTruthy();
    expect(api.renameSharedFile).not.toHaveBeenCalled();
  });

  it("moves into a folder chosen on the tree", async () => {
    mount(core(), "sessions/t-munykjig");
    const pane = await select("report-1.md");
    fireEvent.click(await within(pane).findByRole("button", { name: /Move/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /^uploads/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move here" }));
    await waitFor(() => expect(api.moveSharedFile).toHaveBeenCalledWith("c1", "sessions/t-munykjig/report-1.md", "uploads"));
  });

  it("deletes only after a confirmation that names the file", async () => {
    mount(core(), "sessions/t-munykjig");
    const pane = await select("report-1.md");
    fireEvent.click(await within(pane).findByRole("button", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("shared/sessions/t-munykjig/report-1.md")).toBeTruthy();
    expect(api.deleteSharedFile).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteSharedFile).toHaveBeenCalledWith("c1", "sessions/t-munykjig/report-1.md"));
    await waitFor(() => expect(filesDrive.get().selected).toBeNull());
  });

  it("puts no key and no S3 address on the page: the image preview is the Panel's own URL", async () => {
    mount(core(), "sessions");
    const pane = await select("home.png");
    const img = (await within(pane).findByRole("img")) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/cores/c1/shared/files/media?path=sessions%2Fhome.png");
    expect(document.body.innerHTML).not.toMatch(/X-Amz|secret|sessionToken|accessKey/i);
  });
});

describe("the New menu and drag-in", () => {
  it("offers New folder, Upload files, Upload folder and New text file", async () => {
    mount();
    await screen.findByText("readme.md");
    fireEvent.click(screen.getByRole("button", { name: /^New$/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["New folder", "Upload files", "Upload folder", "New text file"]);
  });

  it("creates a folder inside the open folder", async () => {
    mount(core(), "sessions");
    await screen.findByText("attempt-1.log");
    fireEvent.click(screen.getByRole("button", { name: /^New$/ }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /New folder/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "drafts" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.makeSharedFolder).toHaveBeenCalledWith("c1", "sessions/drafts/"));
  });

  it("creates an empty text file in the open folder", async () => {
    mount(core(), "sessions");
    await screen.findByText("attempt-1.log");
    fireEvent.click(screen.getByRole("button", { name: /^New$/ }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /New text file/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(FakeXhr.sent).toEqual([{ method: "PUT", url: "/api/cores/c1/shared/files/upload?path=sessions%2Funtitled.txt", size: 0 }]));
  });

  it("uploads a picked folder with its whole tree, each file with its relative path", async () => {
    mount(core(), "uploads");
    await screen.findByText(/Drop files or folders/);
    const input = screen.getByLabelText("Upload folder") as HTMLInputElement;
    expect(input.hasAttribute("webkitdirectory")).toBe(true);
    const make = (name: string, rel: string) => {
      const f = new File(["abc"], name);
      Object.defineProperty(f, "webkitRelativePath", { value: rel });
      return f;
    };
    fireEvent.change(input, { target: { files: [make("a.ts", "brand/src/a.ts"), make("b.ts", "brand/src/deep/b.ts"), make("r.md", "brand/r.md")] } });
    await waitFor(() => expect(FakeXhr.sent).toHaveLength(3));
    expect(FakeXhr.sent.map((s) => decodeURIComponent(s.url.split("path=")[1]!)).sort()).toEqual(["uploads/brand/r.md", "uploads/brand/src/a.ts", "uploads/brand/src/deep/b.ts"]);
    expect(await screen.findAllByText("done")).toHaveLength(3);
  });

  it("takes a drop anywhere, with a progress row for each file", async () => {
    mount(core(), "uploads");
    const zone = await screen.findByLabelText("Shared folder");
    const files = [new File(["1"], "one.txt"), new File(["22"], "two.txt")];
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files, items: [] } });
    await waitFor(() => expect(FakeXhr.sent).toHaveLength(2));
    expect(screen.getByRole("region", { name: "Uploads" })).toBeTruthy();
    expect(screen.getByLabelText("Upload uploads/one.txt")).toBeTruthy();
    expect(screen.getByLabelText("Upload uploads/two.txt")).toBeTruthy();
  });

  it("leaves out a file over the upload limit and says so, sending the rest", async () => {
    mount(core(), "uploads");
    const zone = await screen.findByLabelText("Shared folder");
    await waitFor(() => expect(api.getSharedFilesSummary).toHaveBeenCalled());
    await screen.findByText("412 MB used · SeaweedFS");
    const big = new File([new Uint8Array(2000)], "big.bin");
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [big, new File(["x"], "ok.txt")], items: [] } });
    await waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
    expect(await screen.findByText(/larger than the upload limit/)).toBeTruthy();
  });
});
