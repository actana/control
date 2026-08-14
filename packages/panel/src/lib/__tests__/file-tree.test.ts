// The flat listing, as a tree (#226).
//
// The assertions worth reading here are the ones about what the Core *did not*
// send: a manifest that names a child before its parent, and one that never
// names the parent at all. Both arrive in practice — the walk has its own order
// and the listing is capped mid-stream — and both have to produce a tree an
// operator can open, because the alternative is a file that cannot be reached.
import { describe, expect, it } from "vitest";
import { buildFileTree, visibleRows, type FileTreeNode } from "~/lib/file-tree";
import type { CoreFileEntry } from "~/lib/core-files";

function file(path: string, size = 0): CoreFileEntry {
  return { path, size, mtime: 1, mode: 0o100644, sha256: null, kind: "file" };
}

function dir(path: string): CoreFileEntry {
  return { path, size: 0, mtime: 1, mode: 0o040755, sha256: null, kind: "directory" };
}

/** The paths a render would produce, in order, with their depth. */
function shown(nodes: FileTreeNode[], expanded: string[]): string[] {
  return visibleRows(nodes, new Set(expanded)).map((row) => `${"  ".repeat(row.depth)}${row.node.name}`);
}

describe("building the tree", () => {
  it("nests each path under the folders it names", () => {
    const tree = buildFileTree([dir("src"), file("src/index.ts", 2048), file("readme.md", 12)]);
    expect(tree.map((n) => n.path)).toEqual(["src", "readme.md"]);
    expect(tree[0]!.children.map((n) => n.path)).toEqual(["src/index.ts"]);
  });

  it("takes a folder that arrives after its own children", () => {
    // The order the panel's own fixture uses, and the Core's walk is free to
    // pick it: the child creates the node, the folder's line fills it in.
    const tree = buildFileTree([file("src/index.ts"), dir("src")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.directory).toBe(true);
    expect(tree[0]!.entry).not.toBeNull();
    expect(tree[0]!.children.map((n) => n.name)).toEqual(["index.ts"]);
  });

  it("implies a folder the listing never named", () => {
    // What a capped or depth-limited listing looks like from here. The folder
    // is a row with nothing behind it — reachable, and honest about having no
    // `stat` of its own.
    const tree = buildFileTree([file("incoming/deep/bye.txt")]);
    expect(tree[0]!.path).toBe("incoming");
    expect(tree[0]!.entry).toBeNull();
    expect(tree[0]!.directory).toBe(true);
    expect(tree[0]!.children[0]!.path).toBe("incoming/deep");
    expect(tree[0]!.children[0]!.children[0]!.name).toBe("bye.txt");
  });

  it("orders folders before files, then by name, at every level", () => {
    const tree = buildFileTree([
      file("zeta.txt"),
      file("alpha.txt"),
      dir("src"),
      file("src/b.ts"),
      file("src/a.ts"),
      dir("src/nested"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["src", "alpha.txt", "zeta.txt"]);
    expect(tree[0]!.children.map((n) => n.name)).toEqual(["nested", "a.ts", "b.ts"]);
  });

  it("reads a slash-padded path as the same path, and an empty one as no row", () => {
    const tree = buildFileTree([file("/incoming//hello.txt"), file("")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.path).toBe("incoming");
    expect(tree[0]!.children[0]!.path).toBe("incoming/hello.txt");
  });
});

describe("what renders", () => {
  const tree = buildFileTree([
    dir("incoming"),
    file("incoming/hello.txt"),
    dir("incoming/deep"),
    file("incoming/deep/bye.txt"),
    file("readme.md"),
  ]);

  it("shows folders closed, so a Project is its top level and nothing else", () => {
    expect(shown(tree, [])).toEqual(["incoming", "readme.md"]);
  });

  it("opens one level at a time", () => {
    expect(shown(tree, ["incoming"])).toEqual([
      "incoming",
      "  deep",
      "  hello.txt",
      "readme.md",
    ]);
    expect(shown(tree, ["incoming", "incoming/deep"])).toEqual([
      "incoming",
      "  deep",
      "    bye.txt",
      "  hello.txt",
      "readme.md",
    ]);
  });

  it("does not walk what is closed", () => {
    // The cost of a closed `node_modules` is one row, whatever is under it.
    const rows = visibleRows(tree, new Set(["incoming/deep"]));
    expect(rows.map((r) => r.node.name)).toEqual(["incoming", "readme.md"]);
  });

  it("says which rows are open, and never says it of a file", () => {
    const rows = visibleRows(tree, new Set(["incoming", "readme.md"]));
    expect(rows.find((r) => r.node.name === "incoming")!.expanded).toBe(true);
    expect(rows.find((r) => r.node.name === "readme.md")!.expanded).toBe(false);
  });
});
