// @vitest-environment jsdom
//
// The browser's half of the file surface (#129 F6/F8/F11, #169).
//
// Two properties here are load-bearing rather than incidental, and both are
// invisible in the code unless you already know to look for them:
//
//   • **a folder drop is walked**, because `dataTransfer.files` is empty for one
//     and `webkitGetAsEntry` is the only way in;
//   • **uploads are strictly sequential**, because the Core takes one write
//     transfer per Project and refuses a second immediately rather than queuing
//     it (F8). Firing a folder's files in parallel would turn one drop into a
//     burst of 409s with one arbitrary winner.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { filesFromDrop, listProjectFiles, uploadProjectFile } from "~/lib/core-files";
import { useProjectFileUploads } from "~/lib/use-project-files";

vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({ cores: [], loading: false, error: null }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ndjsonResponse(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } },
  );
}

describe("reading a drop", () => {
  it("takes the flat file list when the entry API is not there", async () => {
    const a = new File(["a"], "a.txt");
    const b = new File(["b"], "b.txt");
    const dataTransfer = {
      items: [{ kind: "file" }, { kind: "file" }],
      files: [a, b],
    } as unknown as DataTransfer;

    expect(await filesFromDrop(dataTransfer)).toEqual([
      { path: "a.txt", file: a },
      { path: "b.txt", file: b },
    ]);
  });

  it("walks a dropped folder and keeps each file's path inside it", async () => {
    const leaf = new File(["leaf"], "leaf.txt");
    const nested = new File(["deep"], "deep.txt");

    const fileEntry = (name: string, file: File) => ({
      name,
      isFile: true,
      isDirectory: false,
      file: (resolve: (f: File) => void) => resolve(file),
    });
    // `readEntries` answers in batches and signals the end with an empty one —
    // a directory reader that returned everything in one call would hide the
    // bug where only the first slice of a large folder is uploaded.
    const dirEntry = (name: string, children: unknown[]) => {
      let served = false;
      return {
        name,
        isFile: false,
        isDirectory: true,
        createReader: () => ({
          readEntries: (resolve: (entries: unknown[]) => void) => {
            resolve(served ? [] : children);
            served = true;
          },
        }),
      };
    };

    const root = dirEntry("bundle", [
      fileEntry("leaf.txt", leaf),
      dirEntry("inner", [fileEntry("deep.txt", nested)]),
    ]);
    const dataTransfer = {
      items: [{ kind: "file", webkitGetAsEntry: () => root }],
      files: [],
    } as unknown as DataTransfer;

    expect(await filesFromDrop(dataTransfer)).toEqual([
      { path: "bundle/leaf.txt", file: leaf },
      { path: "bundle/inner/deep.txt", file: nested },
    ]);
  });
});

describe("the listing", () => {
  it("yields entries as they arrive and stops at `done`", async () => {
    fetchMock.mockResolvedValue(
      ndjsonResponse([
        { type: "entry", path: "a.txt", size: 3, mtime: 1, mode: 0o100644, sha256: null },
        { type: "done" },
        { type: "entry", path: "never-read.txt" },
      ]),
    );

    const paths: string[] = [];
    for await (const entry of listProjectFiles("core_a", "p1")) paths.push(entry.path);
    expect(paths).toEqual(["a.txt"]);
  });

  it("carries the Core's refusal code rather than a status number", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: "project-not-found", error: "no such Project" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(async () => {
      for await (const _ of listProjectFiles("core_a", "p1")) void _;
    }).rejects.toMatchObject({ code: "project-not-found", status: 404 });
  });
});

describe("one write transfer per Project", () => {
  it("sends a drop's files one after another, never at once", async () => {
    const releases: (() => void)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    fetchMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Held open until the test lets it go, so "sequential" means something:
      // with a parallel implementation both requests would be counted here
      // before either was released.
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return ndjsonResponse([
        { type: "entry", path: "x", size: 1, mtime: 1, mode: 0o100644, sha256: null, result: "written" },
        { type: "done", entries: 1, bytes: 1 },
      ]);
    });

    const { result } = renderHook(() => useProjectFileUploads("core_a", "p1"));
    const dropped = [
      { path: "one.txt", file: new File(["1"], "one.txt") },
      { path: "two.txt", file: new File(["2"], "two.txt") },
    ];

    let settled: Promise<void>;
    act(() => {
      settled = result.current.send(dropped);
    });

    await waitFor(() => expect(releases.length).toBe(1));
    releases[0]!();
    await waitFor(() => expect(releases.length).toBe(2));
    releases[1]!();
    await act(async () => {
      await settled!;
    });

    expect(maxInFlight).toBe(1);
    expect(result.current.items.map((item) => item.path)).toEqual(["one.txt", "two.txt"]);
    expect(result.current.items.every((item) => item.state === "written")).toBe(true);
  });

  it("lets the rest of a drop land when one file is refused", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "transfer-in-progress", error: "busy" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValue(
        ndjsonResponse([
          { type: "entry", path: "two.txt", size: 1, mtime: 1, mode: 0o100644, sha256: null, result: "written" },
          { type: "done", entries: 1, bytes: 1 },
        ]),
      );

    const { result } = renderHook(() => useProjectFileUploads("core_a", "p1"));
    await act(async () => {
      await result.current.send([
        { path: "one.txt", file: new File(["1"], "one.txt") },
        { path: "two.txt", file: new File(["2"], "two.txt") },
      ]);
    });

    expect(result.current.items[0]).toMatchObject({ state: "failed", error: "busy" });
    expect(result.current.items[1]).toMatchObject({ state: "written" });
  });
});

describe("an upload's request", () => {
  it("hands the File over unread, with the mtime it had on the operator's disk", async () => {
    const file = new File(["hello"], "hello.txt", { lastModified: 1_700_000_000_000 });
    fetchMock.mockResolvedValue(ndjsonResponse([{ type: "done", entries: 1, bytes: 5 }]));

    for await (const _ of uploadProjectFile({
      coreId: "core_a",
      projectId: "p1",
      path: "notes/hello.txt",
      file,
    })) {
      void _;
    }

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/cores/core_a/projects/p1/files?path=notes%2Fhello.txt");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(file);
    expect((init.headers as Record<string, string>)["x-actana-file-mtime"]).toBe(
      "1700000000000",
    );
    // Not set by this module: the browser fills it from `file.size` for a Blob
    // body and forbids script from touching it, which is what gets the Core a
    // real length for its free-space precheck without anyone claiming one.
    expect((init.headers as Record<string, string>)["content-length"]).toBeUndefined();
  });
});
