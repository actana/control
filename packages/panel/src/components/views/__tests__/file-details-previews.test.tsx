// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CoreFileChange, SharedFileDetails, SharedFileEntry } from "~/shared/shared-files";

// The details pane and the cards (#565): who wrote a file, what it links to, whether it is synced, and previews that are
// rendered, not raw. The Panel's own routes are tested on their own; here the API and the panel link are faked.

const NOW = Date.now();
const PR = "https://github.com/acme/app/pull/581";

const api = vi.hoisted(() => ({
  getSharedFileDetails: vi.fn(),
  sharedFileDownloadUrl: vi.fn(),
  getTask: vi.fn(),
  listCoreAgents: vi.fn(),
}));
vi.mock("~/lib/api", () => ({
  api,
  ApiError: class extends Error {},
  sharedFileMediaUrl: (c: string, p: string) => `/api/cores/${c}/shared/files/media?path=${encodeURIComponent(p)}`,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const sessionRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({ listSessionRows: async () => ({ sessions: sessionRows.rows, archivedCount: 0 }) }),
}));

const { FileDetails } = await import("../FileDetails");
const { FilesMain } = await import("../FilesMain");

const entry = (path: string, size = 3482): SharedFileEntry => ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file", size, modifiedAt: NOW - 12_000 });

function answer(e: SharedFileEntry, preview: SharedFileDetails["preview"], pullRequests: string[] = []): SharedFileDetails {
  return { entry: e, preview, links: { pullRequests } };
}

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function details(path: string, props: { coreChange?: CoreFileChange; coreLive?: boolean } = {}) {
  return wrap(<FileDetails coreId="c1" path={path} isNew={false} onRename={vi.fn()} onMove={vi.fn()} onDelete={vi.fn()} {...props} />);
}

beforeEach(() => {
  sessionRows.rows = [];
  api.getTask.mockRejectedValue(new Error("no such task"));
  api.listCoreAgents.mockResolvedValue({ agents: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the details pane: who wrote it and what it links to", () => {
  it("names the Session and its harness for a file in sessions/<id>/", async () => {
    sessionRows.rows = [{ sessionId: "t-munykjig", title: "screens", agent: "claude-code", status: "ready" }];
    const path = "sessions/t-munykjig/screens/report-1.md";
    api.getSharedFileDetails.mockResolvedValue(answer(entry(path), { kind: "markdown", text: "# r", truncated: false }));
    details(path);
    expect(await screen.findByText("Written by")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Session t-munykjig · claude-code")).toBeTruthy());
  });

  it("still names the Session when the Core's list has no such row (it is gone or not loaded)", async () => {
    const path = "sessions/t-gone/report-1.md";
    api.getSharedFileDetails.mockResolvedValue(answer(entry(path), { kind: "markdown", text: "# r", truncated: false }));
    details(path);
    expect(await screen.findByText("Session t-gone")).toBeTruthy();
  });

  it("says nothing of a writer for a file no Session or Task owns", async () => {
    api.getSharedFileDetails.mockResolvedValue(answer(entry("uploads/brand/tokens.json"), { kind: "json", text: "{}", truncated: false }));
    details("uploads/brand/tokens.json");
    await screen.findByText("Size");
    expect(screen.queryByText("Written by")).toBeNull();
    expect(screen.queryByText("Linked to")).toBeNull();
  });

  it("links the Task as a link to the board's detail, and names the Task's agent as the writer", async () => {
    const path = "tasks/T-0142/success.md";
    api.getSharedFileDetails.mockResolvedValue(answer(entry(path), { kind: "markdown", text: "ok", truncated: false }));
    api.getTask.mockResolvedValue({ task: { id: "T-0142", title: "Ship the drive", coreId: "c1", agent: "agent_1" }, comments: [] });
    api.listCoreAgents.mockResolvedValue({ agents: [{ id: "agent_1", name: "builder" }] });
    details(path);
    const link = await screen.findByRole("link", { name: "Task Ship the drive" });
    expect(link.getAttribute("href")).toBe("/tasks?task=T-0142");
    await waitFor(() => expect(screen.getByText("Task T-0142 · agent builder")).toBeTruthy());
    expect(api.getTask).toHaveBeenCalledWith("T-0142");
  });

  it("falls back to the Task's id for the link text when the Task cannot be read", async () => {
    const path = "tasks/T-9/fail.md";
    api.getSharedFileDetails.mockResolvedValue(answer(entry(path), { kind: "markdown", text: "no", truncated: false }));
    details(path);
    expect((await screen.findByRole("link", { name: "Task T-9" })).getAttribute("href")).toBe("/tasks?task=T-9");
  });

  it("asks for no Task at all for a file that is not under tasks/", async () => {
    api.getSharedFileDetails.mockResolvedValue(answer(entry("readme.md"), { kind: "markdown", text: "x", truncated: false }));
    details("readme.md");
    await screen.findByText("Size");
    expect(api.getTask).not.toHaveBeenCalled();
  });

  it("links each pull request the server found, to GitHub, in a new tab without a handle back", async () => {
    api.getSharedFileDetails.mockResolvedValue(answer(entry("sessions/s1/report-1.md"), { kind: "markdown", text: "x", truncated: false }, [PR]));
    details("sessions/s1/report-1.md");
    const link = await screen.findByRole("link", { name: "PR acme/app#581" });
    expect(link.getAttribute("href")).toBe(PR);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });
});

describe("the details pane: sync state", () => {
  const path = "sessions/s1/report-1.md";
  beforeEach(() => api.getSharedFileDetails.mockResolvedValue(answer(entry(path, 3482), { kind: "markdown", text: "x", truncated: false })));

  it("says synced to S3 when the Core's last write is the stored size", async () => {
    details(path, { coreChange: { size: 3482, mtime: NOW - 20_000, deleted: false }, coreLive: true });
    expect(await screen.findByText(/just now · synced to S3/)).toBeTruthy();
  });

  it("says syncing for a same-size rewrite the stored copy predates", async () => {
    details(path, { coreChange: { size: 3482, mtime: NOW, deleted: false }, coreLive: true });
    expect(await screen.findByText(/· syncing with the Core/)).toBeTruthy();
  });

  it("says syncing when the Core holds something else", async () => {
    details(path, { coreChange: { size: 9, mtime: NOW, deleted: false }, coreLive: true });
    expect(await screen.findByText(/· syncing with the Core/)).toBeTruthy();
  });

  it("says only that it is in storage when the Core has said nothing, and why when it is offline", async () => {
    const view = details(path, { coreLive: true });
    expect(await screen.findByText(/just now · in storage$/)).toBeTruthy();
    view.unmount();
    details(path, { coreLive: false });
    expect(await screen.findByText(/just now · in storage · Core not connected$/)).toBeTruthy();
  });
});

describe("the details pane: previews", () => {
  it("renders a markdown file, and drops the HTML in it", async () => {
    api.getSharedFileDetails.mockResolvedValue(
      answer(entry("r.md"), { kind: "markdown", text: "# impl report\n\n- [x] sudo removed\n\n<script>window.__pwned = 1</script>\n\n![x](https://evil.test/p.png)", truncated: false }),
    );
    details("r.md");
    const md = await screen.findByTestId("markdown-preview");
    expect(within(md).getByRole("heading", { name: "impl report" })).toBeTruthy();
    expect(within(md).getByRole("checkbox")).toBeTruthy();
    expect(md.innerHTML).not.toMatch(/<script|<img/i);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("says a markdown file was cut", async () => {
    api.getSharedFileDetails.mockResolvedValue(answer(entry("big.md"), { kind: "markdown", text: "# top", truncated: true }));
    details("big.md");
    expect(await screen.findByText(/the rest is in the download/)).toBeTruthy();
  });

  it("prints a JSON file indented, and a cut one as it came", async () => {
    api.getSharedFileDetails.mockResolvedValue(answer(entry("t.json"), { kind: "json", text: '{"surface/bg":"#0b1220","brand":{"accent":"#38bdf8"}}', truncated: false }));
    const view = details("t.json");
    const pre = await screen.findByTestId("file-preview");
    expect(pre.textContent).toBe('{\n  "surface/bg": "#0b1220",\n  "brand": {\n    "accent": "#38bdf8"\n  }\n}');
    view.unmount();
    api.getSharedFileDetails.mockResolvedValue(answer(entry("t.json"), { kind: "json", text: '{"a":1,"b":', truncated: true }));
    details("t.json");
    expect((await screen.findByTestId("file-preview")).textContent).toContain('{"a":1,"b":');
  });

  it("shows a PDF through the Panel's own media route, never a storage address", async () => {
    api.getSharedFileDetails.mockResolvedValue(answer(entry("brief.pdf"), { kind: "pdf" }));
    details("brief.pdf");
    const object = await screen.findByLabelText("PDF preview");
    expect(object.getAttribute("data")).toBe("/api/cores/c1/shared/files/media?path=brief.pdf");
  });
});

describe("the cards", () => {
  const noop = vi.fn();
  function main(entries: SharedFileEntry[]) {
    return wrap(<FilesMain coreId="c1" view="grid" entries={entries} selected={null} newPaths={new Set()} onOpenFolder={noop} onSelect={noop} />);
  }

  it("renders a markdown card, not its source, and without HTML", async () => {
    api.getSharedFileDetails.mockResolvedValue(answer(entry("report-1.md"), { kind: "markdown", text: "# impl-558 report\n\n- [x] sudo removed\n\n<img src=x onerror=alert(1)>", truncated: false }));
    main([entry("report-1.md")]);
    const card = await screen.findByTestId("card-markdown");
    expect(within(card).getByRole("heading", { name: "impl-558 report", hidden: true })).toBeTruthy();
    expect(card.textContent).not.toContain("# impl-558");
    expect(card.innerHTML).not.toMatch(/<img/i);
  });

  it("puts no link, checkbox or block element inside the card's button, and nothing on it to tab to", async () => {
    api.getSharedFileDetails.mockResolvedValue(
      answer(entry("report-1.md"), { kind: "markdown", text: "# head\n\nsee [the PR](https://github.com/acme/app/pull/1) and https://example.test/x\n\n- [x] done\n- [ ] todo\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |", truncated: false }),
    );
    const { container } = main([entry("report-1.md")]);
    const card = await screen.findByTestId("card-markdown");
    // A link is its text, a task-list box is its mark, and the file's own source is still rendered as markdown.
    expect(card.querySelector("a")).toBeNull();
    expect(card.querySelector("input")).toBeNull();
    expect(card.textContent).toContain("the PR");
    expect(card.textContent).toMatch(/\[x\]\s+done/);
    expect(card.textContent).toMatch(/\[ \]\s+todo/);
    expect(card.querySelector("h1")).not.toBeNull();
    // The one button is the name and size line: it holds phrasing content only, and the preview is outside it.
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.contains(card)).toBe(false);
    expect(buttons[0]!.querySelector("a, input, h1, h2, p, ul, li, table, blockquote, pre, div, object")).toBeNull();
    // Nothing inside the card can take focus, so Tab lands on the button alone.
    const focusable = container.querySelectorAll('a[href], input, select, textarea, object, [tabindex]:not([tabindex="-1"])');
    expect(focusable).toHaveLength(0);
  });

  it("selects the file from a click on its preview, and once from a click on its button", () => {
    const onSelect = vi.fn();
    const { container } = wrap(<FilesMain coreId="c1" view="grid" entries={[entry("brief.pdf", 10)]} selected={null} newPaths={new Set()} onOpenFolder={noop} onSelect={onSelect} />);
    fireEvent.click(container.querySelector("[aria-hidden]")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    onSelect.mockClear();
    fireEvent.click(container.querySelector("button")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("brief.pdf");
  });

  it("shows only the top of a long markdown file on its card", async () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n");
    api.getSharedFileDetails.mockResolvedValue(answer(entry("long.md"), { kind: "markdown", text, truncated: false }));
    main([entry("long.md")]);
    const card = await screen.findByTestId("card-markdown");
    expect(card.textContent).toContain("line 0");
    expect(card.textContent).not.toContain("line 39");
  });

  it("prints a JSON card indented", async () => {
    api.getSharedFileDetails.mockResolvedValue(answer(entry("tokens.json", 40), { kind: "json", text: '{"brand":{"accent":"x"}}', truncated: false }));
    const { container } = main([entry("tokens.json", 40)]);
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe('{\n  "brand": {\n    "accent": "x"\n  }\n}'));
  });

  it("gives a PDF a first-page preview from the media route, not interactive and not tabbable", async () => {
    const { container } = main([entry("brief.pdf", 1_200_000)]);
    const object = await waitFor(() => {
      const el = container.querySelector("object");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(object.getAttribute("type")).toBe("application/pdf");
    expect(object.getAttribute("data")).toMatch(/^\/api\/cores\/c1\/shared\/files\/media\?path=brief\.pdf#page=1&/);
    expect(object.getAttribute("aria-label")).toBe("First page of brief.pdf");
    expect(object.getAttribute("tabindex")).toBe("-1");
    expect((object as HTMLElement).style.pointerEvents).toBe("none");
    expect(api.getSharedFileDetails).not.toHaveBeenCalled();
  });

  it("does not fetch a big PDF for a thumbnail: a file icon instead", () => {
    const { container } = main([entry("huge.pdf", 40 * 1024 * 1024)]);
    expect(container.querySelector("object")).toBeNull();
  });

  it("waits until the card is on screen before it starts a PDF viewer", async () => {
    const observed: Array<(hits: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (hits: Array<{ isIntersecting: boolean }>) => void) {
          observed.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      const { container } = main([entry("below-the-fold.pdf", 1000)]);
      expect(container.querySelector("object")).toBeNull();
      observed[0]!([{ isIntersecting: true }]);
      await waitFor(() => expect(container.querySelector("object")).not.toBeNull());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("selects the file on a click, not opens the PDF", () => {
    const onSelect = vi.fn();
    const { container } = wrap(<FilesMain coreId="c1" view="grid" entries={[entry("brief.pdf", 10)]} selected={null} newPaths={new Set()} onOpenFolder={noop} onSelect={onSelect} />);
    fireEvent.click(container.querySelector("button[aria-pressed]")!);
    expect(onSelect).toHaveBeenCalledWith("brief.pdf");
  });
});
