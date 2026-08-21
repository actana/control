// `project` and `harness` against a Core that is actually running (#161).
//
// `project-command.test.ts` and `harness-command.test.ts` inject a client, which
// is what makes the flags, the columns and the exit codes testable — and is
// exactly why they cannot say whether the frames are the right frames. This
// suite closes that: a real `PtyCoreLinkServer` over mTLS, and ports behind it
// that answer the way a Core's own ports do.
//
// The Core's "disk" here is fabricated on purpose. `/srv/core-disk` does not
// exist on the machine running this test, and the folders under it exist
// nowhere at all — so a `browse` that printed them can only have got them from
// the Core, over `dirList`. A listing of the operator's own filesystem is the
// one bug this criterion is about, and it is the one bug a directory port
// pointed at a real temp directory could not detect.

import { describe, it, expect, afterEach } from "vitest";
import { connectCore } from "../core-connection.ts";
import { EXIT_FAILURE, EXIT_OK } from "../exit-codes.ts";
import {
  makeCliFixture,
  projectSnapshot,
  registerCore,
  type CliFixture,
} from "./cli-harness.ts";
import { arrayEventLog, startInProcessCore, type InProcessCore } from "./in-process-core.ts";
import {
  HARNESS_INSTALL_FAILED_EVENT_KIND,
  HARNESSES_AVAILABILITY_EVENT_KIND,
  type CoreLinkHarnessAvailabilityMap,
  type CoreLinkProjectMutation,
  type CoreLinkProjectSnapshot,
} from "@actana/sdk/core-link-frames.ts";
import type {
  CoreDirectoryPort,
  CoreMutationPort,
  CoreQueryPort,
  HarnessInstallPort,
} from "@actana/core/pty-core-link-server";

let core: InProcessCore | null = null;
let fixture: CliFixture | null = null;

afterEach(() => {
  core?.close();
  core = null;
  fixture?.cleanup();
  fixture = null;
});

/** A project store in memory, with the two ports the Core reads and writes through. */
function projectStore(initial: CoreLinkProjectSnapshot[] = []) {
  const rows = [...initial];
  const mutations: CoreLinkProjectMutation[] = [];
  const queryPort: CoreQueryPort = {
    listProjects: () => rows,
    listTasks: () => [],
    listArchivedTasks: () => [],
    countArchivedTasks: () => 0,
    getTask: () => null,
  };
  const mutationPort: CoreMutationPort = {
    mutateProject: (mutation) => {
      mutations.push(mutation);
      if (mutation.op !== "create") return null;
      // The Core's own rule, in miniature: a path is validated on the machine
      // that owns it, and a bad one comes back as an `error` frame.
      if (!mutation.path.startsWith("/srv")) {
        throw new Error(`project path does not exist on the Core: ${mutation.path}`);
      }
      const row = projectSnapshot(mutation.name, mutation.path);
      rows.push(row);
      return row;
    },
    mutateTask: () => null,
    listSessions: () => [],
  };
  return { rows, mutations, queryPort, mutationPort };
}

/** A disk that exists on no machine, which is what makes the browse assertion mean something. */
const coreDisk: CoreDirectoryPort = {
  list: async (requested) => {
    const at = requested ?? "/srv/core-disk";
    return {
      path: at,
      parent: at === "/srv/core-disk" ? "/srv" : "/srv/core-disk",
      home: "/home/actana",
      roots: [{ label: "Home", path: "/home/actana" }],
      entries:
        at === "/srv/core-disk"
          ? [
              { name: "zzz-only-on-the-core", childCount: 2 },
              { name: "second-folder", childCount: 0 },
            ]
          : [],
      truncated: false,
    };
  },
  create: async (parent, name) => `${parent}/${name}`,
};

describe("actana project, against a Core in this process", () => {
  it("lists the Core's Projects over the link", async () => {
    const store = projectStore([projectSnapshot("api", "/srv/work/api", { pinned: true })]);
    core = await startInProcessCore({ queryPort: store.queryPort });
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const run = await fixture.run(["project", "ls", "--json"], { connect: connectCore });

    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(JSON.parse(run.out.join("\n"))).toEqual([
      expect.objectContaining({ name: "api", path: "/srv/work/api", pinned: true }),
    ]);
  }, 30_000);

  it("registers a Project at the path it was given, on the Core", async () => {
    const store = projectStore();
    core = await startInProcessCore({ queryPort: store.queryPort, mutationPort: store.mutationPort });
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    await fixture.run(["project", "add", "api", "/srv/work/api"], { connect: connectCore });
    expect(store.mutations).toEqual([{ op: "create", name: "api", path: "/srv/work/api" }]);

    // It is there when asked again — the round trip, not just the frame.
    const listed = await fixture.run(["project", "ls", "--json"], { connect: connectCore });
    expect(JSON.parse(listed.out.join("\n"))).toHaveLength(1);
  }, 30_000);

  it("reports the Core's own rejection of a path", async () => {
    const store = projectStore();
    core = await startInProcessCore({ queryPort: store.queryPort, mutationPort: store.mutationPort });
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const run = await fixture.run(["project", "add", "api", "/elsewhere/api"], {
      connect: connectCore,
    });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("does not exist on the Core");
  }, 30_000);

  it("browses the Core's disk, not the operator's", async () => {
    core = await startInProcessCore({ directoryPort: coreDisk });
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const run = await fixture.run(["project", "browse", "/srv/core-disk", "--json"], {
      connect: connectCore,
    });

    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.path).toBe("/srv/core-disk");
    // Folders that exist on no filesystem anywhere. Only the Core could have
    // named them.
    expect(payload.entries.map((e: { name: string }) => e.name)).toEqual([
      "zzz-only-on-the-core",
      "second-folder",
    ]);
    expect(payload.home).toBe("/home/actana");
  }, 30_000);

  it("passes a Core with no directory port through as a refusal", async () => {
    core = await startInProcessCore();
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const run = await fixture.run(["project", "browse"], { connect: connectCore });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.out).toEqual([]);
    expect(run.err.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("actana harness, against a Core in this process", () => {
  const missing: CoreLinkHarnessAvailabilityMap = {
    claude: { status: "available", version: "2.1.0", path: "/usr/local/bin/claude" },
    opencode: { status: "missing", reason: "not on PATH" },
  };

  it("lists what the Core reports", async () => {
    core = await startInProcessCore({ availabilityPort: { snapshot: () => missing } });
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const run = await fixture.run(["harness", "ls", "--json"], { connect: connectCore });

    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(JSON.parse(run.out.join("\n"))).toEqual([
      expect.objectContaining({ id: "claude", status: "available" }),
      expect.objectContaining({ id: "opencode", status: "missing" }),
    ]);
  }, 30_000);

  it("exits non-zero on a failed install, names the Harness and links the issue", async () => {
    // The shape #31 and #128 actually take: the installer runs, the Harness is
    // still not on the Core's PATH, and the Core says so on the event log.
    const log = arrayEventLog();
    const installPort: HarnessInstallPort = {
      installable: (id) => id === "opencode",
      install: async () => ({
        ok: false,
        message: "opencode was installed, but `opencode` is still not on this Core's PATH.",
      }),
    };
    core = await startInProcessCore({
      eventLog: log,
      availabilityPort: { snapshot: () => missing },
      installPort,
      liveEventPollMs: 25,
    });
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const run = await fixture.run(["harness", "install", "opencode"], { connect: connectCore });

    expect(run.code).toBe(EXIT_FAILURE);
    const said = run.err.join("\n");
    expect(said).toContain("opencode is not installed");
    expect(said).toContain("still not on this Core's PATH");
    expect(said).toContain("/issues/31");
    expect(said).toContain("/issues/128");
    expect(run.out, "a failed install printed a success line").toEqual([]);
  }, 30_000);

  it("exits 0 when the Core reports the Harness available afterwards", async () => {
    const log = arrayEventLog();
    const availability: CoreLinkHarnessAvailabilityMap = structuredClone(missing);
    const installPort: HarnessInstallPort = {
      installable: (id) => id === "opencode",
      install: async () => {
        // What a Core's install service does on the way out: re-probe, and let
        // the availability change ride the event log.
        availability.opencode = { status: "available", version: "0.6.0", path: "/root/.opencode/bin/opencode" };
        log.push(HARNESSES_AVAILABILITY_EVENT_KIND, JSON.stringify(availability));
        return { ok: true };
      },
    };
    core = await startInProcessCore({
      eventLog: log,
      availabilityPort: { snapshot: () => availability },
      installPort,
      liveEventPollMs: 25,
    });
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const run = await fixture.run(["harness", "install", "opencode", "--json"], {
      connect: connectCore,
    });

    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.installed).toBe(true);
    expect(payload.path).toBe("/root/.opencode/bin/opencode");
  }, 30_000);

  it("ignores a stale `available` sitting past the cap on a long event log", async () => {
    // The blocking defect from the review of #205, in the direction that ends
    // in a lie. The Core replays at most `EVENT_TAIL_LIMIT` (1000) events and
    // closes the tail with the last id it *sent*, so a command that took that
    // marker for the log's tip pins itself at #1000 — and this Core's log holds
    // an `agents:availabilityChanged` at #1200 from an install that worked an
    // hour ago and has since been undone. Past a tip of #1000, that stale map
    // resolves the wait as `{ok: true}` and exits 0 on an install that in fact
    // failed. `harness-command.test.ts` cannot catch it: its fake Core never
    // truncates a replay.
    const log = arrayEventLog();
    const wasAvailable: CoreLinkHarnessAvailabilityMap = {
      ...missing,
      opencode: { status: "available", version: "0.6.0", path: "/root/.opencode/bin/opencode" },
    };
    for (let i = 0; i < 1_500; i += 1) {
      if (i === 1_200) log.push(HARNESSES_AVAILABILITY_EVENT_KIND, JSON.stringify(wasAvailable));
      else log.push("task:updated");
    }

    const installPort: HarnessInstallPort = {
      installable: (id) => id === "opencode",
      // …and today it is not there, and installing it does not put it there.
      install: async () => ({
        ok: false,
        message: "opencode was installed, but `opencode` is still not on this Core's PATH.",
      }),
    };
    core = await startInProcessCore({
      eventLog: log,
      availabilityPort: { snapshot: () => missing },
      installPort,
      liveEventPollMs: 25,
    });
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const run = await fixture.run(["harness", "install", "opencode", "--json"], {
      connect: connectCore,
    });

    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.installed, "an hour-old availability map was read as this install's verdict")
      .toBe(false);
    expect(run.code).toBe(EXIT_FAILURE);
    expect(payload.message).toContain("still not on this Core's PATH");
  }, 60_000);

  it("ignores an install that failed before it asked, past the cap on a long log", async () => {
    // The same defect the other way round, and the case the PR body claims to
    // prevent: `harness:installFailed` for this Harness, from an install that
    // failed an hour ago, sitting at #1200 on a 1500-event log. Read as this
    // install's outcome it turns a success into a reported failure — with the
    // Core's own sentence from an hour ago quoted as the reason.
    const log = arrayEventLog();
    const availability: CoreLinkHarnessAvailabilityMap = structuredClone(missing);
    for (let i = 0; i < 1_500; i += 1) {
      if (i === 1_200) {
        log.push(
          HARNESS_INSTALL_FAILED_EVENT_KIND,
          JSON.stringify({ harness: "opencode", message: "an hour ago, this failed" }),
        );
      } else log.push("task:updated");
    }

    const installPort: HarnessInstallPort = {
      installable: (id) => id === "opencode",
      install: async () => {
        availability.opencode = {
          status: "available",
          version: "0.6.0",
          path: "/root/.opencode/bin/opencode",
        };
        log.push(HARNESSES_AVAILABILITY_EVENT_KIND, JSON.stringify(availability));
        return { ok: true };
      },
    };
    core = await startInProcessCore({
      eventLog: log,
      availabilityPort: { snapshot: () => availability },
      installPort,
      liveEventPollMs: 25,
    });
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const run = await fixture.run(["harness", "install", "opencode", "--json"], {
      connect: connectCore,
    });

    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.installed, "a failure from before this command asked was read as its verdict")
      .toBe(true);
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(payload.path).toBe("/root/.opencode/bin/opencode");
  }, 60_000);

  it("reports a Core that cannot install anything, rather than waiting on it", async () => {
    core = await startInProcessCore({ availabilityPort: { snapshot: () => missing } });
    fixture = makeCliFixture();
    registerCore(fixture.paths, "inproc", core.blobText);

    const run = await fixture.run(["harness", "install", "opencode"], { connect: connectCore });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("cannot install Harnesses");
  }, 30_000);
});
