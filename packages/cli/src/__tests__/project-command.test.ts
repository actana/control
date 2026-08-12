// `actana project` — the surface, without a socket (#161).
//
// The claims under test are the ones a Core cannot make on this command's
// behalf: that `--json` is machine-readable and alone on stdout, that a path is
// sent as the operator typed it rather than resolved against *this* machine,
// that `browse` asks the Core rather than the local disk, and that no verb here
// offers an edit ADR 0022 says cannot be sent.

import { describe, it, expect, afterEach } from "vitest";
import {
  fakeCore,
  makeCliFixture,
  projectSnapshot,
  sentinelBlobText,
  type CliFixture,
} from "./cli-harness.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "../exit-codes.ts";
import type { CoreLinkDirListing } from "@actana/sdk/core-link-frames.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** A registry with one Core in it, which is what every verb below needs. */
async function withRegisteredCore(): Promise<void> {
  const added = await cli().run(["core", "add", "prod"], { stdin: sentinelBlobText() });
  expect(added.code).toBe(EXIT_OK);
}

describe("actana project ls", () => {
  it("emits an array of Projects on stdout and nothing else, with --json", async () => {
    await withRegisteredCore();
    const core = fakeCore({
      projects: [
        projectSnapshot("api", "/srv/work/api"),
        projectSnapshot("web", "/srv/work/web", { pinned: true }),
      ],
    });

    const run = await cli().run(["project", "ls", "--json", "--verbose"], { connect: core.connect });

    expect(run.code).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload).toEqual([
      expect.objectContaining({ name: "api", path: "/srv/work/api", pinned: false }),
      expect.objectContaining({ name: "web", path: "/srv/work/web", pinned: true }),
    ]);
    // `--verbose` was on: every diagnostic it produced went to stderr, or the
    // parse above would have thrown.
    expect(run.err.length).toBeGreaterThan(0);
    expect(core.closed, "project ls left the link open").toBe(true);
  });

  it("prints a table with the Core's paths when --json is off", async () => {
    await withRegisteredCore();
    const core = fakeCore({ projects: [projectSnapshot("api", "/srv/work/api")] });

    const run = await cli().run(["project", "ls"], { connect: core.connect });

    expect(run.code).toBe(EXIT_OK);
    expect(run.out[0]).toContain("NAME");
    expect(run.out.join("\n")).toContain("/srv/work/api");
  });

  it("says so, and exits non-zero, when the Core cannot be reached", async () => {
    await withRegisteredCore();
    const run = await cli().run(["project", "ls", "--json"], {
      connect: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });

    expect(run.code).toBe(EXIT_FAILURE);
    // Not an error object on stdout: a list that could not be fetched is not a
    // list, and a consumer parsing this stream should never receive one.
    expect(run.out).toEqual([]);
    expect(run.err.join("\n")).toContain("ECONNREFUSED");
  });
});

describe("actana project add", () => {
  it("sends the path exactly as typed, to the Core", async () => {
    await withRegisteredCore();
    const core = fakeCore({});

    const run = await cli().run(["project", "add", "api", "/srv/work/api"], {
      connect: core.connect,
    });

    expect(run.code).toBe(EXIT_OK);
    expect(core.mutations).toEqual([{ op: "create", name: "api", path: "/srv/work/api" }]);
  });

  it("refuses a relative path rather than resolving it against this machine", async () => {
    await withRegisteredCore();
    const core = fakeCore({});

    for (const relative of [".", "work/api", "~/work"]) {
      const run = await cli().run(["project", "add", "api", relative], { connect: core.connect });
      expect(run.code, `"${relative}" was accepted`).toBe(EXIT_USAGE);
      expect(run.err.join("\n")).toContain("not on this one");
    }
    // The load-bearing half: nothing was sent, and in particular nothing that
    // had been turned into a path on the operator's own disk.
    expect(core.mutations).toEqual([]);
  });

  it("reports the Core's rejection of a path, and exits non-zero", async () => {
    await withRegisteredCore();
    const core = fakeCore({ refuseMutation: "project path does not exist on the Core: /nope" });

    const run = await cli().run(["project", "add", "api", "/nope"], { connect: core.connect });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("/nope");
    expect(run.out).toEqual([]);
  });

  it("says the path is fixed from here, on the way out", async () => {
    await withRegisteredCore();
    const core = fakeCore({});
    const run = await cli().run(["project", "add", "api", "/srv/work/api"], {
      connect: core.connect,
    });
    expect(run.out.join("\n")).toContain("ADR 0022");
  });
});

describe("a Core-owned Project's path is immutable (ADR 0022)", () => {
  it("offers no verb that would edit one, and says why", async () => {
    await withRegisteredCore();
    const core = fakeCore({});

    for (const verb of ["edit", "mv", "move", "set-path"]) {
      const run = await cli().run(["project", verb, "api", "/elsewhere"], { connect: core.connect });
      // EXIT_USAGE, not EXIT_UNIMPLEMENTED: this is not a verb waiting on a
      // ticket, it is one the protocol has nothing to carry.
      expect(run.code, `project ${verb}`).toBe(EXIT_USAGE);
      expect(run.err.join("\n")).toContain("cannot be changed");
      expect(run.err.join("\n")).toContain("#104");
    }
    expect(core.mutations, "an edit verb reached the Core").toEqual([]);
  });

  it("reserves the phase-3 verbs rather than leaving them to read as typos", async () => {
    await withRegisteredCore();
    for (const verb of ["cp", "files"]) {
      const run = await cli().run(["project", verb]);
      expect(run.code, `project ${verb}`).toBe(EXIT_UNIMPLEMENTED);
      expect(run.err.join("\n")).toContain("#168");
    }
  });
});

describe("actana project browse", () => {
  const listing: CoreLinkDirListing = {
    path: "/srv/work",
    parent: "/srv",
    home: "/home/actana",
    roots: [{ label: "Home", path: "/home/actana" }],
    entries: [
      { name: "api", childCount: 3 },
      { name: "web", childCount: 0 },
    ],
    truncated: false,
  };

  it("walks the Core's disk through dirList, never the operator's", async () => {
    await withRegisteredCore();
    const core = fakeCore({ listing });

    const run = await cli().run(["project", "browse", "/srv/work"], { connect: core.connect });

    expect(run.code).toBe(EXIT_OK);
    expect(core.requests).toEqual([{ type: "dirList", reqId: "", path: "/srv/work" }]);
    expect(run.out.join("\n")).toContain("/srv/work");
    expect(run.out.join("\n")).toContain("api");
  });

  it("lets the Core choose the starting folder when none is given", async () => {
    await withRegisteredCore();
    const core = fakeCore({ listing });

    await cli().run(["project", "browse"], { connect: core.connect });

    // `null`, not this machine's home: the whole subject is the other machine's
    // layout, and the Core is the one that knows it.
    expect(core.requests).toEqual([{ type: "dirList", reqId: "", path: null }]);
  });

  it("emits the listing as one JSON object with --json", async () => {
    await withRegisteredCore();
    const core = fakeCore({ listing });

    const run = await cli().run(["project", "browse", "/srv/work", "--json"], {
      connect: core.connect,
    });

    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.path).toBe("/srv/work");
    expect(payload.entries).toHaveLength(2);
    expect(payload.parent).toBe("/srv");
  });

  it("turns a Core's refusal into a sentence and a non-zero exit", async () => {
    await withRegisteredCore();
    const core = fakeCore({
      respond: () => ({ type: "error", reqId: "r", message: "Folder not found" }),
    });

    const run = await cli().run(["project", "browse", "/nope"], { connect: core.connect });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("Folder not found");
  });
});
