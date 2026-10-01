import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureSharedFolder,
  SharedFolderUnusableError,
  sharedFolderPath,
} from "../shared-folder";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "shared-folder-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("ensureSharedFolder (#561)", () => {
  it("creates <home>/shared when it is missing, and returns its path", () => {
    expect(ensureSharedFolder(home)).toBe(path.join(home, "shared"));
    expect(fs.statSync(sharedFolderPath(home)).isDirectory()).toBe(true);
  });

  it("makes it again after it was deleted", () => {
    ensureSharedFolder(home);
    fs.rmSync(sharedFolderPath(home), { recursive: true });
    ensureSharedFolder(home);
    expect(fs.statSync(sharedFolderPath(home)).isDirectory()).toBe(true);
  });

  it("changes nothing in a folder that is already there: contents and mode stay", () => {
    const folder = sharedFolderPath(home);
    fs.mkdirSync(folder, { mode: 0o750 });
    fs.chmodSync(folder, 0o750);
    fs.writeFileSync(path.join(folder, "report.md"), "keep me");
    ensureSharedFolder(home);
    expect(fs.readFileSync(path.join(folder, "report.md"), "utf8")).toBe("keep me");
    expect(fs.statSync(folder).mode & 0o777).toBe(0o750);
  });

  it("refuses a symbolic link, and does not follow or replace it", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
    try {
      fs.symlinkSync(elsewhere, sharedFolderPath(home));
      expect(() => ensureSharedFolder(home)).toThrow(SharedFolderUnusableError);
      expect(() => ensureSharedFolder(home)).toThrow(/is a symbolic link/);
      expect(fs.lstatSync(sharedFolderPath(home)).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a regular file in its place, and leaves the file", () => {
    fs.writeFileSync(sharedFolderPath(home), "mine");
    expect(() => ensureSharedFolder(home)).toThrow(/not a directory/);
    expect(fs.readFileSync(sharedFolderPath(home), "utf8")).toBe("mine");
  });
});
