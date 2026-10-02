// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "~/lib/api";
import { addPicked, attachmentsForm } from "~/lib/task-attachments";
import { attachmentNote, checkAttachmentPath, taskAttachmentPath } from "~/shared/task-attachments";
import { classifyTaskEntry } from "~/shared/task-report";

// The browser's half of Task attachments (#568, #571): the paths, the multipart body, and that the real api module sends it
// without a JSON content type (the browser must set the boundary itself).

afterEach(() => vi.unstubAllGlobals());

describe("attachment paths", () => {
  it("live under attachments/, so no name is a result file the dispatcher watches", () => {
    for (const name of ["success.md", "fail.md", "partial-3.md", "attempt-1.log", "attempt-2-fail.md"]) {
      expect(taskAttachmentPath("task_1", name)).toBe(`tasks/task_1/attachments/${name}`);
      expect(classifyTaskEntry(`attachments/${name}`)).toEqual({ kind: "other" });
    }
    expect(classifyTaskEntry("success.md").kind).toBe("result");
  });

  it("refuse anything that leaves the folder", () => {
    for (const bad of ["../a", "a/../b", "/a", "a//b", "a\\b", "dir/", ""]) expect(checkAttachmentPath(bad).ok, bad).toBe(false);
    expect(checkAttachmentPath("dir/a.txt")).toEqual({ ok: true, path: "dir/a.txt" });
  });

  it("are named in the note a comment carries, from the harness's home", () => {
    expect(attachmentNote("task_1", ["a.txt", "d/b.txt"])).toBe("Attached files, in ~/shared/tasks/task_1/attachments/:\n- a.txt\n- d/b.txt");
  });
});

describe("what is picked", () => {
  it("keeps a picked folder's tree and drops a refused or repeated path with its reason", () => {
    const f = (name: string, rel?: string) => {
      const file = new File(["x"], name);
      if (rel) Object.defineProperty(file, "webkitRelativePath", { value: rel });
      return file;
    };
    const first = addPicked([], [f("a.txt", "dir/a.txt"), f("b", "../b")]);
    expect(first.items.map((i) => i.path)).toEqual(["dir/a.txt"]);
    expect(first.skipped.map((s) => s.name)).toEqual(["../b"]);
    const again = addPicked(first.items, [f("a.txt", "dir/a.txt"), f("c.txt")]);
    expect(again.items.map((i) => i.path)).toEqual(["dir/a.txt", "c.txt"]);
    expect(again.skipped).toEqual([{ name: "dir/a.txt", reason: "it is already attached" }]);
  });

  it("go in a multipart body: the JSON, each file, and each path in the same order", async () => {
    const form = attachmentsForm({ title: "T" }, [
      { path: "d/a.txt", file: new File(["A"], "a.txt") },
      { path: "b.txt", file: new File(["B"], "b.txt") },
    ]);
    expect(JSON.parse(form.get("json") as string)).toEqual({ title: "T" });
    expect(JSON.parse(form.get("paths") as string)).toEqual(["d/a.txt", "b.txt"]);
    expect(await Promise.all(form.getAll("files").map((v) => (v as File).text()))).toEqual(["A", "B"]);
  });
});

describe("the api module", () => {
  function stub() {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ task: { id: "t" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends a Task with attachments as multipart with no JSON content type, and a plain one as JSON", async () => {
    const fetchMock = stub();
    await api.createTask({ title: "T" }, [{ path: "a.txt", file: new File(["A"], "a.txt") }]);
    const withFiles = fetchMock.mock.calls[0]![1];
    expect(withFiles.body).toBeInstanceOf(FormData);
    expect(Object.keys(withFiles.headers as Record<string, string>).map((h) => h.toLowerCase())).not.toContain("content-type");

    await api.createTask({ title: "T" });
    const plain = fetchMock.mock.calls[1]![1];
    expect(plain.body).toBe(JSON.stringify({ title: "T" }));
    expect((plain.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("sends a comment with a file the same way", async () => {
    const fetchMock = stub();
    await api.commentOnTask("t1", { body: "b", reassign: true }, [{ path: "a.txt", file: new File(["A"], "a.txt") }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/tasks/t1/comments");
    expect(init.body).toBeInstanceOf(FormData);
    expect(JSON.parse((init.body as FormData).get("json") as string)).toEqual({ body: "b", reassign: true });
  });
});
