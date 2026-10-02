// The `current` pointer is written to two files (#580, T-403).
//
// `current.txt` is the pointer Control has always written, and the published `@actana/cli` reads
// `current.json` first, so the machine layer — `actana setup` on metal, the daemon's self-registration
// in a container — writes both. A client that finds only the text file falls back to it, but one that
// finds both never has to guess which is newer.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BLOB_FILE_MODE,
  clearCurrentCore,
  readCurrentCore,
  registryPaths,
  writeCoreBlob,
  writeCurrentCore,
} from "../blob-registry";

const roots: string[] = [];
function paths() {
  const dir = mkdtempSync(path.join(tmpdir(), "actana-current-"));
  roots.push(dir);
  return registryPaths({ XDG_CONFIG_HOME: dir }, "/unused");
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

describe("current.json beside current.txt", () => {
  it("names current.json in the registry paths", () => {
    expect(registryPaths({ XDG_CONFIG_HOME: "/xdg" }, "/h").currentJson).toBe("/xdg/actana/current.json");
  });

  it("writes both files when a Core is made current, at mode 0600", () => {
    const p = paths();
    writeCoreBlob(p, "prod", "blob");
    writeCurrentCore(p, "prod");
    expect(readFileSync(p.currentPointer, "utf8")).toBe("prod\n");
    expect(readJson(p.currentJson)).toEqual({ core: "prod", search: null });
    expect(statSync(p.currentJson).mode & 0o777).toBe(BLOB_FILE_MODE);
    expect(readCurrentCore(p)).toBe("prod");
  });

  it("keeps the Search pointer the client wrote, and replaces the Core one", () => {
    const p = paths();
    writeCoreBlob(p, "a", "blob");
    writeCoreBlob(p, "b", "blob");
    writeCurrentCore(p, "a");
    writeFileSync(p.currentJson, JSON.stringify({ core: "a", search: "kb" }));
    writeCurrentCore(p, "b");
    expect(readJson(p.currentJson)).toEqual({ core: "b", search: "kb" });
  });

  it("rewrites a malformed current.json whole instead of failing", () => {
    const p = paths();
    writeCoreBlob(p, "prod", "blob");
    writeCurrentCore(p, "prod");
    writeFileSync(p.currentJson, "{not json");
    writeCurrentCore(p, "prod");
    expect(readJson(p.currentJson)).toEqual({ core: "prod", search: null });
  });

  it("clears the Core in both and keeps the Search pointer", () => {
    const p = paths();
    writeCoreBlob(p, "prod", "blob");
    writeCurrentCore(p, "prod");
    writeFileSync(p.currentJson, JSON.stringify({ core: "prod", search: "kb" }));
    clearCurrentCore(p);
    expect(existsSync(p.currentPointer)).toBe(false);
    expect(readJson(p.currentJson)).toEqual({ core: null, search: "kb" });
  });

  it("creates no current.json when clearing a registry that never had one", () => {
    const p = paths();
    clearCurrentCore(p);
    expect(existsSync(p.currentJson)).toBe(false);
  });
});
