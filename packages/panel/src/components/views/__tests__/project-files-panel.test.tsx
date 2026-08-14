// @vitest-environment jsdom
//
// The Project files view, and the shape of its absence (#129 F6/F9, #169).
//
// The interesting assertion in this file is the *negative* one. "The file view
// is absent, not broken, against a Core that does not announce `files`" is one
// of #169's done-means, and absence is easy to implement as a spinner that never
// resolves or an error toast about a 404 — both of which look like a fault on a
// Core that has none. So the test asserts the panel says one calm sentence
// **and makes no request at all**: a request would mean the Panel had decided to
// find out the hard way, off a Core that already told it the answer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectFilesPanel } from "../ProjectFilesPanel";

/** The rows on screen, in order, as `path` — closed folders included. */
function renderedPaths(): string[] {
  return [...document.querySelectorAll("[data-testid='project-file-row']")].map(
    (row) => row.getAttribute("data-path") ?? "",
  );
}

/** The row for a path, as a drag would find it. */
function row(path: string): HTMLElement {
  const found = document.querySelector(`[data-path="${path}"]`);
  if (!found) throw new Error(`no row for ${path} — rows are ${renderedPaths().join(", ")}`);
  return found as HTMLElement;
}

/**
 * A drag of files from the desktop.
 *
 * `types` is the load-bearing field: during a `dragover` the browser withholds
 * a drag's contents, so it is all the view has to decide whether to accept the
 * drop at all. The `files` list stands in for what the drop itself carries.
 */
function fileDrag(files: File[] = []): DataTransfer {
  return {
    types: ["Files"],
    items: files.map(() => ({ kind: "file" })),
    files,
    dropEffect: "none",
  } as unknown as DataTransfer;
}

/** The `PUT`s the panel has made, as [path, init] pairs. */
function writes(): [string, RequestInit][] {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
  ) as [string, RequestInit][];
}

type Dial = { state: string; files?: { version: 1 } | null };

let CORES: { id: string; label: string; dial: Dial }[] = [];

vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({ cores: CORES, loading: false, error: null }),
}));

/** One NDJSON body, as a streamed `fetch` answer. */
function ndjsonResponse(lines: unknown[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
    ...init,
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  CORES = [{ id: "core_a", label: "prod-vm-1", dial: { state: "connected", files: { version: 1 } } }];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a Core with a file surface", () => {
  it("lists what the Core streamed, directories first", async () => {
    fetchMock.mockResolvedValue(
      ndjsonResponse([
        { type: "entry", path: "src/index.ts", size: 2048, mtime: 1, mode: 0o100644, sha256: null, kind: "file" },
        { type: "entry", path: "src", size: 0, mtime: 1, mode: 0o040755, sha256: null, kind: "directory" },
        { type: "entry", path: "readme.md", size: 12, mtime: 1, mode: 0o100644, sha256: null, kind: "file" },
        { type: "done" },
      ]),
    );

    render(<ProjectFilesPanel coreId="core_a" projectId="p1" projectName="acme" />);

    await waitFor(() => expect(renderedPaths()).toEqual(["src", "readme.md"]));

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/api/cores/core_a/projects/p1/files/list");
  });

  // #226. The whole listing at once is the defect: a Project holding a
  // `node_modules` renders as thousands of rows nobody can close.
  it("keeps folders closed until they are opened, and opens one level", async () => {
    fetchMock.mockResolvedValue(
      ndjsonResponse([
        { type: "entry", path: "incoming", size: 0, mtime: 1, mode: 0o040755, sha256: null, kind: "directory" },
        { type: "entry", path: "incoming/hello.txt", size: 2048, mtime: 1, mode: 0o100644, sha256: null, kind: "file" },
        { type: "entry", path: "incoming/deep/bye.txt", size: 3, mtime: 1, mode: 0o100644, sha256: null, kind: "file" },
        { type: "done" },
      ]),
    );

    render(<ProjectFilesPanel coreId="core_a" projectId="p1" projectName="acme" />);

    await waitFor(() => expect(renderedPaths()).toEqual(["incoming"]));
    expect(screen.queryByText("hello.txt")).toBeNull();

    fireEvent.click(screen.getByTitle("incoming"));
    expect(renderedPaths()).toEqual(["incoming", "incoming/deep", "incoming/hello.txt"]);
    // One level: `incoming/deep` is a row, and what is inside it is not.
    expect(screen.queryByText("bye.txt")).toBeNull();
    expect(screen.getByText("2.0 KB")).toBeTruthy();

    fireEvent.click(screen.getByTitle("incoming/deep"));
    expect(renderedPaths()).toEqual([
      "incoming",
      "incoming/deep",
      "incoming/deep/bye.txt",
      "incoming/hello.txt",
    ]);

    fireEvent.click(screen.getByTitle("incoming"));
    expect(renderedPaths()).toEqual(["incoming"]);
  });

  it("keeps what is open across a refresh of the listing", async () => {
    // A fresh body per call: a `Response` can only be read once, and this test
    // reads the listing twice.
    fetchMock.mockImplementation(async () =>
      ndjsonResponse([
        { type: "entry", path: "incoming", size: 0, mtime: 1, mode: 0o040755, sha256: null, kind: "directory" },
        { type: "entry", path: "incoming/hello.txt", size: 1, mtime: 1, mode: 0o100644, sha256: null, kind: "file" },
        { type: "done" },
      ]),
    );

    render(<ProjectFilesPanel coreId="core_a" projectId="p1" projectName="acme" />);
    await waitFor(() => expect(renderedPaths()).toEqual(["incoming"]));
    fireEvent.click(screen.getByTitle("incoming"));
    expect(renderedPaths()).toEqual(["incoming", "incoming/hello.txt"]);

    // A re-read replaces every node in the tree — including the one the
    // operator opened, which is why the open set is held by path.
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() =>
      expect(renderedPaths()).toEqual(["incoming", "incoming/hello.txt"]),
    );
  });
});

describe("a Core that announces no file surface", () => {
  it("says so, and asks it nothing", async () => {
    CORES = [{ id: "core_a", label: "old-vm", dial: { state: "connected", files: null } }];

    render(<ProjectFilesPanel coreId="core_a" projectId="p1" projectName="acme" />);

    expect(screen.getByTestId("project-files-absent")).toBeTruthy();
    expect(screen.getByText(/announces no file surface/)).toBeTruthy();
    // Not "no failed request" — *no request*. The capability said everything
    // there was to know, and asking anyway is what turns a supported state into
    // an error somebody has to triage.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the same whether that Core is reachable or not", () => {
    CORES = [{ id: "core_a", label: "old-vm", dial: { state: "unreachable", files: null } }];
    render(<ProjectFilesPanel coreId="core_a" projectId="p1" projectName="acme" />);
    expect(screen.getByText(/announces no file surface/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("distinguishes a Core that is merely down from one that has no files", () => {
    CORES = [{ id: "core_a", label: "prod-vm-1", dial: { state: "unreachable", files: { version: 1 } } }];
    render(<ProjectFilesPanel coreId="core_a" projectId="p1" projectName="acme" />);
    expect(screen.getByText("This Core is not reachable")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("has nothing to show for a Project the Panel owns itself", () => {
    render(<ProjectFilesPanel coreId={null} projectId="p1" projectName="acme" />);
    expect(screen.getByText(/not on a Core/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a dropped file's progress", () => {
  it("names an overwrite in the Core's own words", async () => {
    const file = new File(["second"], "readme.md", { type: "text/plain" });
    fetchMock
      // The listing this panel does on mount.
      .mockResolvedValueOnce(ndjsonResponse([{ type: "done" }]))
      // The upload the pending drop triggers.
      .mockResolvedValueOnce(
        ndjsonResponse([
          {
            type: "entry",
            path: "readme.md",
            size: 6,
            mtime: 2,
            mode: 0o100644,
            sha256: "abc",
            result: "overwritten",
          },
          { type: "done", entries: 1, bytes: 6 },
        ]),
      )
      // The re-read that follows a settled upload.
      .mockResolvedValue(ndjsonResponse([{ type: "done" }]));

    render(
      <ProjectFilesPanel
        coreId="core_a"
        projectId="p1"
        projectName="acme"
        pendingDrop={[{ path: "readme.md", file }]}
      />,
    );

    await waitFor(() => expect(screen.getByText("overwritten")).toBeTruthy());
    expect(screen.getByText("readme.md")).toBeTruthy();

    const upload = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
    );
    expect(upload).toBeTruthy();
    const [url, init] = upload as [string, RequestInit];
    expect(url).toContain("path=readme.md");
    // The `File` itself, handed over unread. A `FormData`, an `ArrayBuffer` or a
    // string here would be the browser end of the same buffering the Panel
    // refuses to do — a gigabyte in the tab instead of a gigabyte in the service.
    expect(init.body).toBe(file);
  });
});

describe("a drop onto a folder row", () => {
  /** A listing with a folder in it, re-served on every read. */
  function withIncoming(): void {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return ndjsonResponse([
          { type: "entry", path: "incoming/hello.txt", size: 2, mtime: 1, mode: 0o100644, sha256: null, result: "written" },
          { type: "done", entries: 1, bytes: 2 },
        ]);
      }
      void url;
      return ndjsonResponse([
        { type: "entry", path: "incoming", size: 0, mtime: 1, mode: 0o040755, sha256: null, kind: "directory" },
        { type: "entry", path: "readme.md", size: 4, mtime: 1, mode: 0o100644, sha256: null, kind: "file" },
        { type: "done" },
      ]);
    });
  }

  it("writes under that folder, once", async () => {
    withIncoming();
    render(<ProjectFilesPanel coreId="core_a" projectId="p1" projectName="acme" />);
    await waitFor(() => expect(renderedPaths()).toEqual(["incoming", "readme.md"]));

    const dataTransfer = fileDrag([new File(["hi"], "hello.txt")]);
    fireEvent.dragOver(row("incoming"), { dataTransfer });
    // The row says it is the target, and the panel's root-drop framing is off.
    expect(row("incoming").getAttribute("data-drop-target")).toBe("true");

    fireEvent.drop(row("incoming"), { dataTransfer });
    await waitFor(() => expect(writes()).toHaveLength(1));

    const [url] = writes()[0]!;
    expect(url).toContain("path=incoming%2Fhello.txt");
    // Once. A drop that also reached the panel behind the row would write the
    // same file a second time at the root, and the Core would report the
    // second as an overwrite of nothing the operator asked for.
    expect(writes()).toHaveLength(1);
    expect(screen.getByText("incoming/hello.txt")).toBeTruthy();
  });

  it("still writes at the root when the drop misses every folder", async () => {
    withIncoming();
    render(<ProjectFilesPanel coreId="core_a" projectId="p1" projectName="acme" />);
    await waitFor(() => expect(renderedPaths()).toEqual(["incoming", "readme.md"]));

    const dataTransfer = fileDrag([new File(["hi"], "hello.txt")]);
    // A file row is not a folder, so this falls through to the panel — the
    // behaviour every drop had before folders became targets.
    fireEvent.drop(row("readme.md"), { dataTransfer });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![0]).toContain("path=hello.txt");
  });
});
