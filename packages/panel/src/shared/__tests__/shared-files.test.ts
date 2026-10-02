import { describe, expect, it } from "vitest";
import {
  baseName,
  breadcrumbs,
  checkEntryName,
  checkSharedPath,
  displayPath,
  formatBytes,
  joinPath,
  parentOf,
  previewKindOf,
  taskFolderPath,
  taskIdOfPath,
} from "../shared-files";

describe("the path rule both ends share", () => {
  it.each(["", "a", "a/b.txt", "a/b/", "a b/c d.txt", "%2e%2e", "é/ü.md"])("accepts %j", (p) => {
    expect(checkSharedPath(p)).toEqual({ ok: true, path: p });
  });
  it.each(["/abs", "../x", "a/../b", "a/./b", "./a", "a//b", "a\\b", "a\u0000b", "..", "."])("refuses %j", (p) => {
    expect(checkSharedPath(p).ok).toBe(false);
  });
  it("says whether it needs a file or a folder", () => {
    expect(checkSharedPath("a/", "file").ok).toBe(false);
    expect(checkSharedPath("", "file").ok).toBe(false);
    expect(checkSharedPath("a", "folder").ok).toBe(false);
    expect(checkSharedPath("a/", "folder").ok).toBe(true);
    expect(checkSharedPath("", "folder").ok).toBe(true);
    expect(checkSharedPath(5 as unknown, "either").ok).toBe(false);
  });
});

describe("names and paths", () => {
  it("splits and joins", () => {
    expect(parentOf("a/b/c.txt")).toBe("a/b");
    expect(parentOf("a/b/")).toBe("a");
    expect(parentOf("top")).toBe("");
    expect(baseName("a/b/c.txt")).toBe("c.txt");
    expect(baseName("a/b/")).toBe("b");
    expect(joinPath("", "x")).toBe("x");
    expect(joinPath("a/b", "x")).toBe("a/b/x");
    expect(joinPath("a/b/", "x")).toBe("a/b/x");
  });
  it("makes breadcrumbs from the root down", () => {
    expect(breadcrumbs("")).toEqual([{ label: "Shared folder", path: "" }]);
    expect(breadcrumbs("sessions/t1/screens")).toEqual([
      { label: "Shared folder", path: "" },
      { label: "sessions", path: "sessions" },
      { label: "t1", path: "sessions/t1" },
      { label: "screens", path: "sessions/t1/screens" },
    ]);
  });
  it("shows a path the way the machine has it, and finds a Task's folder", () => {
    expect(displayPath("sessions/r.md")).toBe("shared/sessions/r.md");
    expect(displayPath("")).toBe("shared");
    expect(taskFolderPath("T-0142")).toBe("tasks/T-0142");
    expect(taskIdOfPath("tasks/T-0142/out/a.md")).toBe("T-0142");
    expect(taskIdOfPath("tasks/T-0142")).toBe("T-0142");
    expect(taskIdOfPath("other/tasks/x")).toBeNull();
  });
  it("accepts one-segment names only", () => {
    expect(checkEntryName("  notes.md ")).toEqual({ ok: true, name: "notes.md" });
    for (const bad of ["", "  ", "a/b", "a\\b", "..", ".", "x".repeat(256)]) expect(checkEntryName(bad).ok).toBe(false);
  });
  it("picks a preview by name, and never previews an SVG as an image", () => {
    expect(previewKindOf("a.PNG")).toBe("image");
    expect(previewKindOf("r.md")).toBe("markdown");
    expect(previewKindOf("t.json")).toBe("json");
    expect(previewKindOf("x.log")).toBe("log");
    expect(previewKindOf("b.pdf")).toBe("pdf");
    expect(previewKindOf("e.svg")).toBe("none");
    expect(previewKindOf("page.html")).toBe("text");
    expect(previewKindOf("noext")).toBe("none");
  });
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(3482)).toBe("3.4 KB");
    expect(formatBytes(84 * 1024)).toBe("84 KB");
    expect(formatBytes(412 * 1024 * 1024)).toBe("412 MB");
  });
});
