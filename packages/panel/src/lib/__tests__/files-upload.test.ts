import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ makeSharedFolder: vi.fn(async () => ({ path: "" })) }));
vi.mock("~/lib/api", () => ({ api, sharedFileUploadUrl: (c: string, p: string) => `/up/${c}?path=${p}` }));

const { planUploads, runUploads, sourcesFromFileList } = await import("../files-upload");
const { filesDrive } = await import("../files-drive-store");

function file(name: string, rel?: string, size = 3): File {
  const f = new File([new Uint8Array(size)], name);
  if (rel) Object.defineProperty(f, "webkitRelativePath", { value: rel });
  return f;
}

beforeEach(() => {
  filesDrive.reset();
  api.makeSharedFolder.mockClear();
});

describe("what a pick or a drop becomes", () => {
  it("keeps a picked folder's whole tree under where it is going", () => {
    const sources = sourcesFromFileList([
      file("readme.md", "brand/readme.md"),
      file("a.ts", "brand/src/a.ts"),
      file("b.ts", "brand/src/deep/b.ts"),
      file("loose.txt"),
    ]);
    const plan = planUploads("uploads/2026", sources);
    expect(plan.files.map((f) => f.path)).toEqual([
      "uploads/2026/brand/readme.md",
      "uploads/2026/brand/src/a.ts",
      "uploads/2026/brand/src/deep/b.ts",
      "uploads/2026/loose.txt",
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("goes to the root when no folder is open, and carries an empty folder as a folder", () => {
    const plan = planUploads("", [
      { kind: "file", file: file("a.txt"), relPath: "a.txt" },
      { kind: "folder", relPath: "proj/empty" },
    ]);
    expect(plan.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(plan.folders).toEqual(["proj/empty"]);
  });

  it("leaves out a path the Panel would refuse, and says why, instead of uploading it somewhere else", () => {
    const plan = planUploads("d", [
      { kind: "file", file: file("x"), relPath: "../x" },
      { kind: "file", file: file("y"), relPath: "a//y" },
      { kind: "file", file: file("ok"), relPath: "ok" },
    ]);
    expect(plan.files.map((f) => f.path)).toEqual(["d/ok"]);
    expect(plan.skipped.map((s) => s.name)).toEqual(["../x", "a//y"]);
    expect(plan.skipped[0]!.reason).toMatch(/\.\./);
  });

  it("sends a name that appears twice once", () => {
    const plan = planUploads("", [
      { kind: "file", file: file("a"), relPath: "a" },
      { kind: "file", file: file("a"), relPath: "a" },
    ]);
    expect(plan.files).toHaveLength(1);
  });
});

describe("running uploads", () => {
  it("sends every file, three at a time at most, each with its own progress, and makes the empty folders", async () => {
    const plan = planUploads("", [
      ...Array.from({ length: 7 }, (_, i) => ({ kind: "file" as const, file: file(`f${i}`, undefined, 10), relPath: `d/f${i}` })),
      { kind: "folder" as const, relPath: "d/empty" },
    ]);
    let running = 0;
    let peak = 0;
    const sent: string[] = [];
    const send = vi.fn(async (_core: string, path: string, f: File, onProgress: (n: number) => void) => {
      running += 1;
      peak = Math.max(peak, running);
      onProgress(f.size / 2);
      await new Promise((r) => setTimeout(r, 5));
      sent.push(path);
      running -= 1;
    });
    const ok = await runUploads("c1", plan, { send });
    expect(ok).toBe(true);
    expect(peak).toBe(3);
    expect(sent.sort()).toEqual(Array.from({ length: 7 }, (_, i) => `d/f${i}`));
    expect(api.makeSharedFolder).toHaveBeenCalledWith("c1", "d/empty/");
    const rows = filesDrive.get().uploads;
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.status === "done" && r.loaded === 10)).toBe(true);
  });

  it("marks the file that failed and goes on with the others", async () => {
    const plan = planUploads("", [
      { kind: "file", file: file("good"), relPath: "good" },
      { kind: "file", file: file("bad"), relPath: "bad" },
      { kind: "file", file: file("after"), relPath: "after" },
    ]);
    const send = vi.fn(async (_c: string, path: string) => {
      if (path === "bad") throw new Error("The file is larger than the upload limit.");
    });
    const ok = await runUploads("c1", plan, { send });
    expect(ok).toBe(false);
    const by = Object.fromEntries(filesDrive.get().uploads.map((u) => [u.path, u]));
    expect(by.good!.status).toBe("done");
    expect(by.after!.status).toBe("done");
    expect(by.bad).toMatchObject({ status: "error", error: "The file is larger than the upload limit." });
  });

  it("shows what was left out as a failed row", async () => {
    const plan = planUploads("", [{ kind: "file", file: file("x"), relPath: "../x" }]);
    expect(await runUploads("c1", plan, { send: vi.fn() })).toBe(false);
    expect(filesDrive.get().uploads[0]).toMatchObject({ path: "../x", status: "error" });
  });
});
