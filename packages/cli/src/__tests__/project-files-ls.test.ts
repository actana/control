// `actana project files` — the listing (#168).
//
// The claim under test is the ticket's fourth "done when": *`project files
// --json` is machine-readable, like every other list command in the CLI.* What
// makes that true is not that a JSON flag exists, but that its output is one
// document, alone on stdout, with the diagnostics that would corrupt it on
// stderr — and that the document says everything the answer depends on. That
// last part is why this verb carries `{entries, truncated}` where `project ls`
// carries a bare array: `--limit` can clip the answer, and a consumer reading
// stdout has no other way to find out. The rest of the suite is the table, the
// two flags that cost the Core real work, and the exit codes.

import { describe, it, expect, afterEach } from "vitest";
import { fakeProjectFiles, makeCliFixture, sentinelBlobText, type CliFixture } from "./cli-harness.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../exit-codes.ts";
import type { CoreFileEntry } from "@actana/sdk/core-files.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

async function withRegisteredCore(): Promise<void> {
  expect((await cli().run(["core", "add", "prod"], { stdin: sentinelBlobText() })).code).toBe(EXIT_OK);
}

function entry(overrides: Partial<CoreFileEntry> & Pick<CoreFileEntry, "path">): CoreFileEntry {
  return { size: 0, mtime: 1_760_000_000_000, mode: 0o644, sha256: null, ...overrides };
}

const TREE: CoreFileEntry[] = [
  entry({ path: "bin", kind: "directory", mode: 0o755 }),
  entry({ path: "bin/deploy", kind: "file", size: 18, mode: 0o755 }),
  entry({ path: "readme.md", kind: "file", size: 6 }),
  entry({ path: "link.md", kind: "symlink", size: 9, mode: 0o777 }),
];

describe("--json is machine-readable, like every other list command", () => {
  it("emits one document on stdout and nothing else, with --verbose on", async () => {
    await withRegisteredCore();
    const files = fakeProjectFiles({ entries: TREE });

    const run = await cli().run(["project", "files", "api", "--json", "--verbose"], {
      files: files.open,
    });

    expect(run.code).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload).toEqual({
      entries: [
        { path: "bin", kind: "directory", size: 0, mtime: 1_760_000_000_000, mode: 0o755, sha256: null },
        {
          path: "bin/deploy",
          kind: "file",
          size: 18,
          mtime: 1_760_000_000_000,
          mode: 0o755,
          sha256: null,
        },
        { path: "readme.md", kind: "file", size: 6, mtime: 1_760_000_000_000, mode: 0o644, sha256: null },
        { path: "link.md", kind: "symlink", size: 9, mtime: 1_760_000_000_000, mode: 0o777, sha256: null },
      ],
      truncated: false,
    });
    // The diagnostics went somewhere, and it was not the stream being parsed.
    expect(run.err.length).toBeGreaterThan(0);
    expect(files.closed, "project files left the gateway open").toBe(true);
  });

  it("emits an empty entries array for an empty Project, not a sentence", async () => {
    // The shape a script reads must not change with the number of rows: `[]` is
    // an answer, and "Nothing under api." is a parse error.
    await withRegisteredCore();
    const files = fakeProjectFiles({ entries: [] });

    const run = await cli().run(["project", "files", "api", "--json"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(JSON.parse(run.out.join("\n"))).toEqual({ entries: [], truncated: false });
  });

  it("carries the mode as a number, so a consumer can test the executable bit", async () => {
    await withRegisteredCore();
    const files = fakeProjectFiles({ entries: [entry({ path: "run.sh", kind: "file", mode: 0o755 })] });

    const run = await cli().run(["project", "files", "api", "--json"], { files: files.open });

    const [row] = JSON.parse(run.out.join("\n")).entries;
    expect(row.mode & 0o111).toBeTruthy();
  });
});

describe("a clipped listing says so in the document, not only on stderr", () => {
  // The gap this closes: a script running `--json --limit 100` could not tell a
  // complete tree from a clipped one, and the warning it would have needed was
  // on the stream it does not read.
  it("carries truncated:true, and the entries it did read", async () => {
    await withRegisteredCore();
    const files = fakeProjectFiles({ entries: TREE });

    const run = await cli().run(["project", "files", "api", "--json", "--limit", "2"], {
      files: files.open,
    });

    expect(run.code).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.truncated).toBe(true);
    expect(payload.entries.map((row: { path: string }) => row.path)).toEqual(["bin", "bin/deploy"]);
    // Still exactly one document on stdout — the fact went into it, not beside it.
    expect(run.err.join("\n")).toContain("--limit 2");
  });

  it("says truncated:false when the tree holds exactly --limit entries", async () => {
    // The false positive: stopping at `>=` made a tree of exactly four entries
    // claim there was a fifth. There is not, and a warning that fires on an
    // exact fit is one an operator learns to ignore.
    await withRegisteredCore();
    const files = fakeProjectFiles({ entries: TREE });

    const run = await cli().run(["project", "files", "api", "--json", "--limit", "4"], {
      files: files.open,
    });

    expect(run.code).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.truncated).toBe(false);
    expect(payload.entries).toHaveLength(4);
    expect(run.err.join("\n")).not.toContain("--limit");
  });

  it("stays quiet on an exact fit in the table mode too", async () => {
    // Same rule, the other output mode — the count is decided before either
    // branch, so neither can disagree with the other about it.
    await withRegisteredCore();
    const files = fakeProjectFiles({ entries: TREE });

    const run = await cli().run(["project", "files", "api", "--limit", "4"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("link.md");
    expect(run.err.join("\n")).not.toContain("--limit");
  });
});

describe("the table a person reads", () => {
  it("shows the mode, the size and the path, with ls -F endings", async () => {
    await withRegisteredCore();
    const files = fakeProjectFiles({ entries: TREE });

    const run = await cli().run(["project", "files", "api"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    const out = run.out.join("\n");
    expect(out).toContain("MODE");
    // Octal, because the reason this surface carries a mode at all is the
    // executable bit surviving a transfer, and 755 is how somebody about to
    // type `chmod` thinks about it.
    expect(out).toContain("755");
    expect(out).toContain("bin/");
    expect(out).toContain("link.md@");
    expect(out).not.toContain("SHA256");
  });

  it("says so plainly when there is nothing there", async () => {
    await withRegisteredCore();
    const files = fakeProjectFiles({ entries: [] });
    const run = await cli().run(["project", "files", "api:src"], { files: files.open });
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("Nothing under api:src");
  });
});

describe("the flags that cost the Core work are opt-in", () => {
  it("asks for no digests unless --sha256 was typed", async () => {
    await withRegisteredCore();
    const files = fakeProjectFiles({ entries: TREE });

    await cli().run(["project", "files", "api"], { files: files.open });

    // A listing has no bytes in hand, so a digest means reading every file
    // under the path (ADR 0027 D6). Off is the Core's default and this one's.
    expect(files.lists[0]).not.toHaveProperty("sha256");
  });

  it("passes --sha256 through and gives the digest a column", async () => {
    await withRegisteredCore();
    const files = fakeProjectFiles({
      entries: [entry({ path: "a.txt", kind: "file", sha256: "abc123" })],
    });

    const run = await cli().run(["project", "files", "api", "--sha256"], { files: files.open });

    expect(files.lists[0]).toMatchObject({ sha256: true });
    expect(run.out.join("\n")).toContain("SHA256");
    expect(run.out.join("\n")).toContain("abc123");
  });

  it("passes a subtree and a --depth straight through", async () => {
    await withRegisteredCore();
    const files = fakeProjectFiles({ entries: TREE });

    await cli().run(["project", "files", "api:src/lib", "--depth", "2"], { files: files.open });

    expect(files.resolved).toEqual(["api"]);
    expect(files.lists[0]).toMatchObject({ path: "src/lib", depth: 2 });
  });

  it("refuses a --depth that is not a number of levels, before dialling", async () => {
    await withRegisteredCore();
    const run = await cli().run(["project", "files", "api", "--depth", "all"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("--depth all");
  });

  it("stops at --limit and says the tree has more", async () => {
    await withRegisteredCore();
    const files = fakeProjectFiles({ entries: TREE });

    const run = await cli().run(["project", "files", "api", "--limit", "2"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("bin/deploy");
    expect(run.out.join("\n")).not.toContain("readme.md");
    // Silently truncating a listing is how a script comes to believe a folder
    // has two files in it.
    expect(run.err.join("\n")).toContain("--limit 2");
  });
});

describe("the command line", () => {
  it("needs a Project, and dials nothing to say so", async () => {
    await withRegisteredCore();
    const run = await cli().run(["project", "files"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("a Project is required");
  });

  it("takes the subtree inside the same argument, not as a second one", async () => {
    await withRegisteredCore();
    const run = await cli().run(["project", "files", "api", "src"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("api:src/lib");
  });

  it("reports a refusal on stderr, and as a document when --json promised one", async () => {
    await withRegisteredCore();
    const files = fakeProjectFiles({
      entries: [],
      listFails: new Error("src/nope does not exist in this Project (not-found)"),
    });

    const run = await cli().run(["project", "files", "api:src/nope", "--json"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(run.out.join("\n")).error).toContain("not-found");
    expect(run.err.join("\n")).toContain("actana project files:");
  });

  it("reports a Core that never answered", async () => {
    await withRegisteredCore();
    const run = await cli().run(["project", "files", "api"], {
      files: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("did not answer");
  });
});
