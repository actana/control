import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confineToProjectRoot, freeSpaceBytes, resolveDeepestExisting, withinRoot } from "../files-confinement";
import { cleanupTrees, makeTree } from "./files-fixture";

// Confinement (#165 F3): the three cases the ticket names, plus the ones that
// make the third of them a real check rather than a string test.
//
// **These are accident-guard tests, not sandbox-escape tests.** They assert
// that a mistake is refused with a reason an operator can read. They do not
// assert containment against someone who wants out — `core shell` is the
// sanctioned way onto this machine's disk, so there is nothing here to escape
// and this suite must not be read as claiming otherwise (ADR 0029).

afterEach(() => cleanupTrees());

describe("an absolute path is refused", () => {
  it("refuses a POSIX absolute path, naming what it got", () => {
    const root = makeTree({ "a.txt": "a" });
    const result = confineToProjectRoot(root, "/etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("absolute-path");
    expect(result.message).toContain("/etc/passwd");
  });

  it("refuses a bare `/`", () => {
    const root = makeTree();
    const result = confineToProjectRoot(root, "/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("absolute-path");
  });

  it("refuses an absolute path that happens to point back inside the Project", () => {
    // The rule is about the *shape* of what a client may send, not about where
    // it lands. Every path on this surface is Project-relative, so accepting an
    // absolute one that resolves inside would make the address space two
    // things at once.
    const root = makeTree({ "a.txt": "a" });
    const result = confineToProjectRoot(root, path.join(root, "a.txt"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("absolute-path");
  });
});

describe("a `..` escape is refused", () => {
  it("refuses a leading `..`", () => {
    const root = makeTree();
    const result = confineToProjectRoot(root, "../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("dot-dot-segment");
  });

  it("refuses a `..` buried in the middle, which is the one that reads as harmless", () => {
    const root = makeTree({ "src/": "" });
    const result = confineToProjectRoot(root, "src/../../outside/x.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("dot-dot-segment");
  });

  it("refuses a `..` that would have cancelled out and stayed inside", () => {
    // `src/../a.txt` is `a.txt` and lands in the Project. It is still refused:
    // a path that needs to walk up to say where it is going is a path built by
    // string concatenation somewhere, and that is the bug worth surfacing.
    const root = makeTree({ "a.txt": "a" });
    const result = confineToProjectRoot(root, "src/../a.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("dot-dot-segment");
  });

  it("accepts a `.` segment, which means nothing and escapes nothing", () => {
    const root = makeTree({ "a.txt": "a" });
    const result = confineToProjectRoot(root, "./a.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolute).toBe(path.join(root, "a.txt"));
  });

  it("accepts a file whose name merely starts with dots", () => {
    const root = makeTree({ "..hidden": "x", "...odd": "y" });
    expect(confineToProjectRoot(root, "..hidden").ok).toBe(true);
    expect(confineToProjectRoot(root, "...odd").ok).toBe(true);
  });
});

describe("a symlink resolving outside the Project root is refused", () => {
  it("refuses a symlink that points out of the Project", () => {
    const outside = makeTree({ "secret.txt": "not yours" });
    const root = makeTree();
    fs.symlinkSync(outside, path.join(root, "escape"));

    const result = confineToProjectRoot(root, "escape/secret.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside-project-root");
      // The message says where it actually went, which is the fact an operator
      // needs and the one a string check could never have produced.
      expect(result.message).toContain(outside);
    }
  });

  it("refuses the symlink itself, not only paths under it", () => {
    const outside = makeTree({ "secret.txt": "not yours" });
    const root = makeTree();
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));

    const result = confineToProjectRoot(root, "escape.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside-project-root");
  });

  it("accepts a symlink that resolves back inside the Project", () => {
    const root = makeTree({ "real/a.txt": "a" });
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));

    const result = confineToProjectRoot(root, "link/a.txt");
    expect(result.ok).toBe(true);
    // Resolved, not merely permitted: the absolute path handed back is where
    // the bytes will land, so everything downstream works on the real location.
    if (result.ok) expect(result.absolute).toBe(path.join(root, "real/a.txt"));
  });

  it("accepts a Project whose own root runs through a symlink", () => {
    // The root is realpath'd too, or a Project registered at `~/work` →
    // `/mnt/data/work` would fail every check it ever made.
    const real = makeTree({ "a.txt": "a" });
    const alias = makeTree();
    const aliasRoot = path.join(alias, "project");
    fs.symlinkSync(real, aliasRoot);

    const result = confineToProjectRoot(aliasRoot, "a.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolute).toBe(path.join(real, "a.txt"));
  });

  it("validates after resolution — a path of innocent segments can still leave", () => {
    // Nothing in `pkg/vendor/lib.js` is absolute and nothing is `..`. Every
    // string check passes. It lands outside anyway, because `vendor` is a
    // symlink — which is the whole reason resolution comes first.
    const outside = makeTree({ "lib.js": "stolen" });
    const root = makeTree({ "pkg/": "" });
    fs.symlinkSync(outside, path.join(root, "pkg/vendor"));

    const result = confineToProjectRoot(root, "pkg/vendor/lib.js");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside-project-root");
  });
});

describe("a path that does not exist yet", () => {
  it("resolves against the deepest ancestor that does, so an upload can name it", () => {
    const root = makeTree({ "src/": "" });
    const result = confineToProjectRoot(root, "src/new/deeper/file.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolute).toBe(path.join(root, "src/new/deeper/file.txt"));
  });

  it("still refuses one whose existing ancestor is a symlink pointing out", () => {
    const outside = makeTree();
    const root = makeTree();
    fs.symlinkSync(outside, path.join(root, "out"));

    const result = confineToProjectRoot(root, "out/brand/new/file.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside-project-root");
  });
});

describe("the empty path is the Project root itself", () => {
  it("accepts `` and `.` and hands back the root", () => {
    const root = makeTree();
    for (const requested of ["", ".", "./"]) {
      const result = confineToProjectRoot(root, requested);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.absolute).toBe(root);
        expect(result.relative).toBe("");
      }
    }
  });
});

describe("malformed input", () => {
  it("refuses a NUL byte rather than letting the syscall layer see it", () => {
    const root = makeTree();
    const result = confineToProjectRoot(root, "a\0b");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed-path");
  });

  it("refuses a backslash, which is not a separator here and is never meant", () => {
    const root = makeTree();
    const result = confineToProjectRoot(root, "..\\..\\etc\\passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed-path");
  });

  it("refuses when the Project root itself does not resolve", () => {
    const result = confineToProjectRoot("/nowhere/that/exists", "a.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside-project-root");
  });
});

describe("withinRoot", () => {
  it("does not mistake a sibling with a shared prefix for a child", () => {
    expect(withinRoot("/srv/application/x", "/srv/app")).toBe(false);
    expect(withinRoot("/srv/app/x", "/srv/app")).toBe(true);
    expect(withinRoot("/srv/app", "/srv/app")).toBe(true);
  });
});

describe("resolveDeepestExisting", () => {
  it("returns the path itself when nothing above it exists either", () => {
    // `/` always resolves, so this never loops forever — the guard is asserted
    // rather than assumed.
    const resolved = resolveDeepestExisting("/definitely/not/here/at/all");
    expect(resolved).toBe("/definitely/not/here/at/all");
  });
});

describe("the free-space precheck", () => {
  it("reports a number for a real directory", async () => {
    const root = makeTree();
    const available = await freeSpaceBytes(root);
    expect(available === null || available >= 0).toBe(true);
    if (available !== null) expect(Number.isFinite(available)).toBe(true);
  });

  it("answers null rather than zero when it cannot measure", async () => {
    // Null is "do not know" and the caller must not read it as "full". A path
    // that does not exist is the cheapest way to reach that branch.
    expect(await freeSpaceBytes("/nowhere/that/exists")).toBeNull();
  });

  it("measures the filesystem, not the directory — a fresh temp dir is not empty of space", async () => {
    const root = makeTree({ "a.txt": "a" });
    const available = await freeSpaceBytes(root);
    if (available === null) return; // statfs unavailable on this filesystem
    expect(available).toBeGreaterThan(0);
    expect(fs.existsSync(root)).toBe(true);
  });
});
