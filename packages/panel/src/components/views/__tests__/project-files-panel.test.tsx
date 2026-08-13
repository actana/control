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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ProjectFilesPanel } from "../ProjectFilesPanel";

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
        { type: "done" },
      ]),
    );

    render(<ProjectFilesPanel coreId="core_a" projectId="p1" projectName="acme" />);

    await waitFor(() => expect(screen.getByText("src/index.ts")).toBeTruthy());
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    const rows = [...document.querySelectorAll("li[title], li")]
      .map((li) => li.textContent ?? "")
      .filter((text) => text.includes("src"));
    expect(rows[0]).toContain("src");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/api/cores/core_a/projects/p1/files/list");
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
