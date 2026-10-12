// The triaged files stay deleted, asserted rather than eyeballed.
//
// ADR 0016 D46 / #58 deletes the triaged working files (`.scratch/`, the old
// specs and tickets) and repoints every reference to them. A deletion is not
// a check, so this is: a restored directory, or a new reference to a dead path,
// fails here. Everything is read from the working tree and `git ls-files`,
// never from history.
//
// The needles are assembled at runtime so this file does not match itself,
// and it is excluded from the scan explicitly as well.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const SELF = "scripts/__tests__/triaged-files-gone.test.mjs";

const scratch = [".", "scratch"].join("");
const specs = ["docs", "specs"].join("/");
const tickets = ["docs", "tickets"].join("/");

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
})
  .split("\0")
  .filter((file) => file !== "" && fs.existsSync(path.join(repoRoot, file)));

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const under = (dir) => tracked.filter((file) => file.startsWith(`${dir}/`));

describe("triaged files are gone (ADR 0016 D46, #58)", () => {
  it.each([scratch, specs, tickets])(
    "%s has no tracked file and no directory", // D46 / #58
    (dir) => {
      expect(under(dir)).toEqual([]);
      expect(fs.existsSync(path.join(repoRoot, dir))).toBe(false);
    },
  );

  it("issue-tracker.md has no Historical working notes section", () => {
    // D46 / #58: the section pointed into the deleted directories.
    expect(read(".agents/issue-tracker.md")).not.toMatch(
      /^#{1,6}\s+Historical working notes\b/m,
    );
  });

  it("no workflow mentions the scratch directory", () => {
    // D46 / #58: ci.yml's documentation-only regex used to name it.
    const offenders = under(".github/workflows").filter((file) =>
      read(file).includes(scratch),
    );
    expect(offenders).toEqual([]);
  });

  it(".dockerignore has no scratch-directory line", () => {
    // D46 / #58: nothing is left to exclude from the build context.
    expect(read(".dockerignore")).not.toContain(scratch);
  });

  it("docs/README.md has no Historical record section", () => {
    // D46 / #58: the section indexed the deleted specs and tickets.
    expect(read("docs/README.md")).not.toMatch(/^#{1,6}\s+Historical record\b/m);
  });

  it("no file under docs/ links to ../specs", () => {
    // D46 / #58: docs/upstream is gone too, so nothing there can link either.
    const needle = ["..", "specs"].join("/");
    const offenders = under("docs").filter(
      (file) => /\.md$/.test(file) && read(file).includes(needle),
    );
    expect(offenders).toEqual([]);
  });

  it("schema-bootstrap.ts is gone or cites no dead path", () => {
    // D46 / #58: it used to cite the deleted specs (global scan below too).
    const file = "packages/shared/src/schema-bootstrap.ts";
    if (!fs.existsSync(path.join(repoRoot, file))) return;
    const text = read(file);
    for (const needle of [scratch, specs, tickets]) {
      expect(text).not.toContain(needle);
    }
  });

  it("no tracked text file names a deleted path", () => {
    // D46 / #58: every reference was repointed, none left dangling.
    const offenders = [];
    for (const file of tracked) {
      if (file === SELF) continue;
      const buf = fs.readFileSync(path.join(repoRoot, file));
      if (buf.includes(0)) continue; // binary
      const text = buf.toString("utf8");
      for (const needle of [scratch, specs, tickets]) {
        if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
