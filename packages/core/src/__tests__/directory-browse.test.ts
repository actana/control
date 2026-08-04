import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectory, listDirectory } from "../directory-browse";

// The folder picker's whole contract, exercised against a real filesystem —
// the Core is the only process that can answer these questions honestly,
// so a test that stubbed `fs` would prove nothing about the answers it gives.

const made: string[] = [];

function tmpTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-dir-browse-"));
  made.push(root);
  return fs.realpathSync(root);
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("listDirectory", () => {
  it("lists subdirectories, sorted, with their visible child counts", async () => {
    const root = tmpTree();
    fs.mkdirSync(path.join(root, "warehouse", "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "warehouse", "docs"));
    fs.mkdirSync(path.join(root, "atlas"));
    fs.writeFileSync(path.join(root, "README.md"), "not a folder");

    const listing = await listDirectory(root, { home: root });

    expect(listing.path).toBe(root);
    expect(listing.entries).toEqual([
      { name: "atlas", childCount: 0 },
      { name: "warehouse", childCount: 2 },
    ]);
    expect(listing.truncated).toBe(false);
  });

  it("hides dotfolders — they are invisible to the picker, so creating one would vanish", async () => {
    const root = tmpTree();
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "visible"));

    const listing = await listDirectory(root, { home: root });

    expect(listing.entries.map((e) => e.name)).toEqual(["visible"]);
  });

  it("starts at the Core's home when the Panel names no path", async () => {
    const home = tmpTree();
    fs.mkdirSync(path.join(home, "projects"));

    const listing = await listDirectory(null, { home });

    expect(listing.path).toBe(home);
    expect(listing.home).toBe(home);
    expect(listing.entries.map((e) => e.name)).toEqual(["projects"]);
  });

  it("offers home plus the standard folders that actually exist on this machine", async () => {
    const home = tmpTree();
    fs.mkdirSync(path.join(home, "Documents"));
    fs.mkdirSync(path.join(home, "Developer"));
    fs.writeFileSync(path.join(home, "Desktop"), "a file, not a folder");

    const listing = await listDirectory(home, { home });

    expect(listing.roots).toEqual([
      { label: "Home", path: home },
      { label: "Developer", path: path.join(home, "Developer") },
      { label: "Documents", path: path.join(home, "Documents") },
    ]);
  });

  it("reports the parent, and null at the filesystem root", async () => {
    const root = tmpTree();
    const child = path.join(root, "nested");
    fs.mkdirSync(child);

    expect((await listDirectory(child, { home: root })).parent).toBe(root);
    expect((await listDirectory("/", { home: root })).parent).toBeNull();
  });

  it("caps a huge directory and says so", async () => {
    const root = tmpTree();
    for (let i = 0; i < 12; i++) fs.mkdirSync(path.join(root, `dir-${String(i).padStart(2, "0")}`));

    const listing = await listDirectory(root, { home: root, limit: 5 });

    expect(listing.entries).toHaveLength(5);
    expect(listing.entries[0]!.name).toBe("dir-00");
    expect(listing.truncated).toBe(true);
  });

  it("rejects a path that does not exist with a message meant for the operator", async () => {
    const root = tmpTree();
    await expect(listDirectory(path.join(root, "nope"), { home: root })).rejects.toThrow(
      "Folder not found",
    );
  });

  it("rejects a path that names a file", async () => {
    const root = tmpTree();
    const file = path.join(root, "notes.txt");
    fs.writeFileSync(file, "hello");

    await expect(listDirectory(file, { home: root })).rejects.toThrow("Not a folder");
  });
});

describe("createDirectory", () => {
  it("creates one folder under the named parent and returns its path", async () => {
    const root = tmpTree();

    const created = await createDirectory(root, "warehouse");

    expect(created).toBe(path.join(root, "warehouse"));
    expect(fs.statSync(created).isDirectory()).toBe(true);
  });

  it("refuses names that would escape the parent or hide the result", async () => {
    const root = tmpTree();

    for (const name of ["..", ".hidden", "a/b", "a\\b", "", "   "]) {
      await expect(createDirectory(root, name)).rejects.toThrow("Invalid folder name");
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("refuses a parent that is not a folder on this machine", async () => {
    const root = tmpTree();

    await expect(createDirectory(path.join(root, "nope"), "child")).rejects.toThrow(
      "Location not found",
    );
  });

  it("says so when something with that name is already there", async () => {
    const root = tmpTree();
    fs.mkdirSync(path.join(root, "warehouse"));

    await expect(createDirectory(root, "warehouse")).rejects.toThrow(
      "Something with that name already exists here",
    );
  });
});
