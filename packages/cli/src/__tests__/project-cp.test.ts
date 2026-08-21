// `actana project cp` — the verb, without a Core (#168).
//
// The claims under test are the four "done when" lines of #168 plus the two
// traps, and each is a fact about *this* program rather than about a Core:
//
//   - a folder copies both ways and keeps its executable bits
//   - progress is visible on a terminal and absent under `--json`
//   - every overwrite is named in the output
//   - the F8 refusal says **who** holds the Project, not just "busy"
//   - the `<project>:<path>` parse is unambiguous (its own suite, next door)
//   - nothing here validates a remote path: the Core owns the disk (F3, F11)
//
// The gateway is faked, and the archive is not: an upload's tar is drained,
// unpacked by `local-tar.ts`, and asserted on. So "keeps its executable bits"
// is checked against real bytes on a real disk, with only the HTTPS hop
// replaced.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fakeProjectFiles,
  fakeTerminal,
  makeCliFixture,
  registerCore,
  streamOf,
  type CliFixture,
} from "./cli-harness.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../exit-codes.ts";
import { packLocalTree, unpackTarInto } from "../local-tar.ts";
import { CoreFilesConflictError, CoreFilesStreamError } from "@actana/sdk/core-files-http.ts";
import type { CoreFileProgress } from "@actana/sdk/core-files.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}

const temporary: string[] = [];
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-cp-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
  while (temporary.length > 0) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

async function withRegisteredCore(): Promise<void> {
  registerCore(cli().paths, "prod");
}

/** A folder with something executable in it, which is the point of the ticket. */
function buildTree(root: string): string {
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "readme.md"), "hello\n");
  fs.writeFileSync(path.join(root, "bin", "deploy"), "#!/bin/sh\necho hi\n");
  fs.chmodSync(path.join(root, "bin", "deploy"), 0o755);
  return root;
}

/** One `entry` progress line, as the Core reports one. */
function entryLine(entryPath: string, result: "written" | "overwritten", size = 10): CoreFileProgress {
  return { type: "entry", path: entryPath, result, size, mtime: 0, mode: 0o644, sha256: null };
}

describe("a folder copies both ways, and keeps its executable bits", () => {
  it("goes up as one archive with the modes intact", async () => {
    await withRegisteredCore();
    const source = buildTree(scratch());
    const files = fakeProjectFiles();

    const run = await cli().run(["project", "cp", source, "api:build"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    // One archive, not N writes — which is what carries a mode at all.
    expect(files.uploads).toHaveLength(1);
    expect(files.uploads[0]).toMatchObject({ path: "build", kind: "tar" });

    // And the archive is real: unpacked here, the executable is still one.
    const landed = scratch();
    await unpackTarInto(chunksOf(files.uploads[0]!.body), landed, () => {});
    expect(fs.readFileSync(path.join(landed, "readme.md"), "utf8")).toBe("hello\n");
    expect(fs.statSync(path.join(landed, "bin", "deploy")).mode & 0o777).toBe(0o755);
    expect(files.closed, "project cp left the gateway open").toBe(true);
  });

  it("comes down as one archive with the modes intact", async () => {
    await withRegisteredCore();
    const remote = buildTree(scratch());
    const dest = path.join(scratch(), "pulled");
    const files = fakeProjectFiles({
      downloadWith: () => ({
        kind: "tar",
        size: null,
        mode: null,
        mtime: null,
        stream: streamOf(packLocalTree(remote)),
      }),
    });

    const run = await cli().run(["project", "cp", "api:build", dest], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(files.downloads).toEqual(["build"]);
    expect(fs.readFileSync(path.join(dest, "readme.md"), "utf8")).toBe("hello\n");
    // The other half of the ticket's first line. An 0o755 that came back 0o644
    // is a `./deploy` that will not run.
    expect(fs.statSync(path.join(dest, "bin", "deploy")).mode & 0o777).toBe(0o755);
  });

  it("round-trips: what came down is what went up", async () => {
    await withRegisteredCore();
    const original = buildTree(scratch());

    const up = fakeProjectFiles();
    expect((await cli().run(["project", "cp", original, "api:build"], { files: up.open })).code).toBe(
      EXIT_OK,
    );

    const archive = up.uploads[0]!.body;
    const down = fakeProjectFiles({
      downloadWith: () => ({
        kind: "tar",
        size: null,
        mode: null,
        mtime: null,
        stream: streamOf(new Uint8Array(archive)),
      }),
    });
    const dest = path.join(scratch(), "again");
    expect((await cli().run(["project", "cp", "api:build", dest], { files: down.open })).code).toBe(
      EXIT_OK,
    );

    expect(fs.readFileSync(path.join(dest, "bin", "deploy"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(fs.statSync(path.join(dest, "bin", "deploy")).mode & 0o777).toBe(0o755);
    // Not `again/<name-of-original>/bin/deploy`: the folder's *contents* land
    // at the destination, so the trip can be made twice without nesting.
    expect(fs.existsSync(path.join(dest, path.basename(original)))).toBe(false);
  });

  it("sends a single file as bytes, with its mode and its length declared", async () => {
    await withRegisteredCore();
    const source = scratch();
    fs.writeFileSync(path.join(source, "run.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(source, "run.sh"), 0o755);
    const files = fakeProjectFiles();

    const run = await cli().run(["project", "cp", path.join(source, "run.sh"), "api:bin/run.sh"], {
      files: files.open,
    });

    expect(run.code).toBe(EXIT_OK);
    expect(files.uploads[0]).toMatchObject({
      path: "bin/run.sh",
      kind: "file",
      mode: 0o755,
      // Declared so the Core can refuse `507` before the bytes cross rather
      // than fail with ENOSPC half-way through.
      contentLength: 10,
    });
    expect(files.uploads[0]!.body.toString("utf8")).toBe("#!/bin/sh\n");
  });

  it("names a file after itself when the destination is a folder", async () => {
    await withRegisteredCore();
    const source = scratch();
    fs.writeFileSync(path.join(source, "notes.md"), "n\n");
    const files = fakeProjectFiles();

    await cli().run(["project", "cp", path.join(source, "notes.md"), "api:docs/"], {
      files: files.open,
    });

    expect(files.uploads[0]!.path).toBe("docs/notes.md");
  });

  it("brings a single file down and applies the mode the Core declared", async () => {
    await withRegisteredCore();
    const dest = path.join(scratch(), "run.sh");
    const files = fakeProjectFiles({
      downloadWith: () => ({
        kind: "file",
        size: 10,
        mode: 0o755,
        mtime: null,
        stream: streamOf(Buffer.from("#!/bin/sh\n")),
      }),
    });

    const run = await cli().run(["project", "cp", "api:bin/run.sh", dest], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(fs.readFileSync(dest, "utf8")).toBe("#!/bin/sh\n");
    expect(fs.statSync(dest).mode & 0o777).toBe(0o755);
  });
});

describe("progress is visible on a terminal and absent under --json", () => {
  it("paints a status line when there is a terminal to paint it on", async () => {
    await withRegisteredCore();
    const source = buildTree(scratch());
    const terminal = fakeTerminal({ isTty: true });
    const files = fakeProjectFiles({
      progressFor: () => [entryLine("readme.md", "written"), { type: "done", entries: 1, bytes: 6 }],
    });

    const run = await cli().run(["project", "cp", source, "api:build"], {
      files: files.open,
      terminal,
    });

    expect(run.code).toBe(EXIT_OK);
    // A rewriting line, and it erases itself: what is left on the screen after
    // the command is the result, not a frozen half-finished tally.
    expect(terminal.painted()).toContain("\r");
    expect(terminal.painted()).toContain("readme.md");
  });

  it("paints nothing at all under --json, and stdout is one document", async () => {
    await withRegisteredCore();
    const source = buildTree(scratch());
    const terminal = fakeTerminal({ isTty: true });
    const files = fakeProjectFiles({
      progressFor: () => [entryLine("readme.md", "written"), { type: "done", entries: 1, bytes: 6 }],
    });

    const run = await cli().run(["project", "cp", source, "api:build", "--json"], {
      files: files.open,
      terminal,
    });

    expect(run.code).toBe(EXIT_OK);
    // Absent, not merely redirected. A consumer parsing stdout must not have to
    // filter a spinner out of it first.
    expect(terminal.painted()).toBe("");
    expect(() => JSON.parse(run.out.join("\n"))).not.toThrow();
  });

  it("paints nothing when the output is a pipe rather than a terminal", async () => {
    // The fixture's default terminal is not a TTY, which is what a `| tee` or a
    // `> log` gives the process. Carriage returns in that file would be noise
    // nobody asked for.
    await withRegisteredCore();
    const source = buildTree(scratch());
    const files = fakeProjectFiles({
      progressFor: () => [entryLine("readme.md", "written")],
    });

    const run = await cli().run(["project", "cp", source, "api:build"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).not.toContain("\r");
  });
});

describe("every overwrite is named (F5)", () => {
  it("names each one on the way up, rather than counting them", async () => {
    await withRegisteredCore();
    const source = buildTree(scratch());
    const files = fakeProjectFiles({
      progressFor: () => [
        entryLine("readme.md", "written"),
        entryLine("bin/deploy", "overwritten"),
        entryLine("config.json", "overwritten"),
        { type: "done", entries: 3, bytes: 30 },
      ],
    });

    const run = await cli().run(["project", "cp", source, "api:build"], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    const out = run.out.join("\n");
    // The paths, in the output. A summary saying "3 entries" over a tree that
    // quietly replaced two of them is the failure F5 exists to prevent.
    expect(out).toContain("overwrote bin/deploy");
    expect(out).toContain("overwrote config.json");
    expect(out).not.toContain("overwrote readme.md");
  });

  it("lists them under `overwritten` in the --json payload", async () => {
    await withRegisteredCore();
    const source = buildTree(scratch());
    const files = fakeProjectFiles({
      progressFor: () => [
        entryLine("readme.md", "written"),
        entryLine("bin/deploy", "overwritten"),
        { type: "done", entries: 2, bytes: 20 },
      ],
    });

    const run = await cli().run(["project", "cp", source, "api:build", "--json"], {
      files: files.open,
    });

    const payload = JSON.parse(run.out.join("\n"));
    expect(payload).toMatchObject({
      direction: "upload",
      project: "api",
      entries: 2,
      written: 1,
      overwritten: ["bin/deploy"],
    });
  });

  it("names them on the way down too, where this side is the one that can see", async () => {
    await withRegisteredCore();
    const remote = buildTree(scratch());
    const dest = scratch();
    // Something already there, so the copy has something to replace.
    fs.writeFileSync(path.join(dest, "readme.md"), "old\n");

    const files = fakeProjectFiles({
      downloadWith: () => ({
        kind: "tar",
        size: null,
        mode: null,
        mtime: null,
        stream: streamOf(packLocalTree(remote)),
      }),
    });

    const run = await cli().run(["project", "cp", "api:build", dest], { files: files.open });

    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("overwrote readme.md");
    expect(fs.readFileSync(path.join(dest, "readme.md"), "utf8")).toBe("hello\n");
  });

  it("names a single file it replaced locally", async () => {
    await withRegisteredCore();
    const dest = path.join(scratch(), "run.sh");
    fs.writeFileSync(dest, "old\n");
    const files = fakeProjectFiles({
      downloadWith: () => ({
        kind: "file",
        size: 4,
        mode: null,
        mtime: null,
        stream: streamOf(Buffer.from("new\n")),
      }),
    });

    const run = await cli().run(["project", "cp", "api:run.sh", dest], { files: files.open });

    expect(run.out.join("\n")).toContain(`overwrote ${dest}`);
  });
});

describe("a transfer that fails part-way still names what it replaced (F5)", () => {
  // The state the SDK models with `CoreFilesStreamError`: the status line was
  // spent on the first entry, so a failure after that arrives as the last line
  // of the progress stream. Entries really landed. F5 does not stop applying
  // because the verb is about to exit non-zero — those files are exactly the
  // ones an operator now has to reason about restoring.
  const diedOnTheTwelfth = new CoreFilesStreamError(
    "io-error",
    "the transfer failed part-way through: write EPIPE",
  );

  it("names the overwrites it made before the connection went, in prose", async () => {
    await withRegisteredCore();
    const source = buildTree(scratch());
    const files = fakeProjectFiles({
      progressFor: () => [
        entryLine("readme.md", "written"),
        entryLine("bin/deploy", "overwritten"),
        entryLine("config.json", "overwritten"),
      ],
      uploadFailsAfterProgress: diedOnTheTwelfth,
    });

    const run = await cli().run(["project", "cp", source, "api:build"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    expect(err).toContain("overwrote bin/deploy");
    expect(err).toContain("overwrote config.json");
    expect(err).not.toContain("overwrote readme.md");
    expect(err).toContain("2 files were replaced");
    // The last thing on the screen is still why it stopped, not a list.
    expect(run.err.at(-1)).toContain("failed part-way through");
  });

  it("carries the same `overwritten` array on the --json error document", async () => {
    // Under `--json` this is the only channel there is: no progress line ever
    // painted, so an operator who cannot read this document cannot find out at
    // all. Same key, same shape as the success payload — the exit code is what
    // says which of the two happened.
    await withRegisteredCore();
    const source = buildTree(scratch());
    const files = fakeProjectFiles({
      progressFor: () => [entryLine("readme.md", "written"), entryLine("bin/deploy", "overwritten")],
      uploadFailsAfterProgress: diedOnTheTwelfth,
    });

    const run = await cli().run(["project", "cp", source, "api:build", "--json"], {
      files: files.open,
    });

    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.error).toContain("failed part-way through");
    expect(payload.overwritten).toEqual(["bin/deploy"]);
    expect(payload.entries).toBe(2);
  });

  it("says nothing extra when the transfer died before anything landed", async () => {
    // The empty case must stay quiet: a failure that replaced nothing should
    // not grow a report about the nothing it replaced.
    await withRegisteredCore();
    const source = buildTree(scratch());
    const files = fakeProjectFiles({ uploadFails: diedOnTheTwelfth });

    const run = await cli().run(["project", "cp", source, "api:build", "--json"], {
      files: files.open,
    });

    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.overwritten).toEqual([]);
    expect(payload.entries).toBe(0);
    expect(run.err.join("\n")).not.toContain("were replaced");
  });
});

describe("a refusal by the one-write-per-Project rule says who holds it (F8)", () => {
  it("carries the Core's own sentence through, path and start time and all", async () => {
    await withRegisteredCore();
    const source = buildTree(scratch());
    // The Core's real message: `transferInProgress` in core-files-routes.ts
    // names *which* transfer and *since when*, because "try again" is useless
    // advice without them.
    const files = fakeProjectFiles({
      uploadFails: new CoreFilesConflictError(
        409,
        "transfer-in-progress",
        "another write transfer is already running on this Project " +
          "(vendor/, started 2026-08-13T09:15:00.000Z) — " +
          "one write at a time per Project; reads are unrestricted and concurrent",
      ),
    });

    const run = await cli().run(["project", "cp", source, "api:build"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    const err = run.err.join("\n");
    // Who, and since when. Not "the Project is busy" — the whole point of the
    // trap is that a client must not throw the answer away.
    expect(err).toContain("vendor/");
    expect(err).toContain("2026-08-13T09:15:00.000Z");
    expect(err).toContain("another write transfer is already running");
    // And it says plainly that nothing was retried, which the Core cannot know.
    expect(err).toContain("Nothing was retried");
    expect(files.closed).toBe(true);
  });

  it("puts the same sentence in the --json payload rather than a shorter one", async () => {
    await withRegisteredCore();
    const source = buildTree(scratch());
    const files = fakeProjectFiles({
      uploadFails: new CoreFilesConflictError(
        409,
        "transfer-in-progress",
        "another write transfer is already running on this Project (vendor/, started 2026-08-13T09:15:00.000Z)",
      ),
    });

    const run = await cli().run(["project", "cp", source, "api:build", "--json"], {
      files: files.open,
    });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(run.out.join("\n")).error).toContain("vendor/");
  });
});

describe("the Core owns the disk, so nothing here validates a remote path (F3, F11)", () => {
  it.each(["api:/etc/passwd", "api:../../escape", "api:", "api:a/../b"])(
    "sends %o as typed and lets the Core answer",
    async (target) => {
      await withRegisteredCore();
      const source = buildTree(scratch());
      const files = fakeProjectFiles();

      const run = await cli().run(["project", "cp", source, target], { files: files.open });

      // No local refusal, no rewriting: the path crossed. A client-side copy of
      // the Core's confinement rules would be a second implementation that
      // cannot see the disk it is ruling on.
      expect(run.code).toBe(EXIT_OK);
      expect(files.uploads).toHaveLength(1);
      expect(files.uploads[0]!.path).toBe(target.slice("api:".length).replace(/\/+$/, ""));
    },
  );

  it("reports the Core's refusal rather than pre-empting it", async () => {
    await withRegisteredCore();
    const source = buildTree(scratch());
    const files = fakeProjectFiles({
      uploadFails: new Error("../../escape leaves the Project root (dot-dot-segment)"),
    });

    const run = await cli().run(["project", "cp", source, "api:../../escape"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("dot-dot-segment");
  });

  it("does answer for the local side, which is the disk it can see", async () => {
    await withRegisteredCore();
    const files = fakeProjectFiles();

    const run = await cli().run(["project", "cp", "/no/such/folder", "api:build"], {
      files: files.open,
    });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("not a file or folder on this machine");
    expect(files.uploads).toHaveLength(0);
  });
});

describe("the command line", () => {
  it("needs two arguments, and dials nothing to say so", async () => {
    await withRegisteredCore();
    const run = await cli().run(["project", "cp", "./only-one"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("a source and a destination are required");
  });

  it("refuses two local paths, and names the command that does that job", async () => {
    await withRegisteredCore();
    const run = await cli().run(["project", "cp", "./a", "./b"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("one side must be <project>:<path>");
  });

  it("refuses two Projects rather than routing Core-to-Core through this laptop", async () => {
    await withRegisteredCore();
    const run = await cli().run(["project", "cp", "api:build", "web:public"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("one local side");
  });

  it("points at the escape hatch when a local name has a colon in it", async () => {
    await withRegisteredCore();
    const run = await cli().run(["project", "cp", "./a", "./b"]);
    expect(run.err.join("\n")).toContain("./name:with-colon");
  });

  it("rejects a third argument rather than silently ignoring it", async () => {
    await withRegisteredCore();
    const run = await cli().run(["project", "cp", "./a", "api:b", "./c"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("unexpected argument");
  });

  it("says which Project it could not find, and what the Core has instead", async () => {
    await withRegisteredCore();
    const source = buildTree(scratch());
    const files = fakeProjectFiles({
      refuseProject: new Error('this Core has no Project "nope". It has: api, web'),
    });

    const run = await cli().run(["project", "cp", source, "nope:build"], { files: files.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("It has: api, web");
  });

  it("reports a Core that never answered, without promising a --json document it has not got", async () => {
    await withRegisteredCore();
    const run = await cli().run(["project", "cp", "./a", "api:b"], {
      files: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("did not answer");
  });
});

/** A buffer as the chunked stream an unpacker reads. */
async function* chunksOf(buffer: Buffer): AsyncGenerator<Uint8Array> {
  yield new Uint8Array(buffer);
}
