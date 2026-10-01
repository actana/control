// `harness` against a Core that is actually running (#161).
//
// `harness-command.test.ts` injects a client, which
// is what makes the flags, the columns and the exit codes testable — and is
// exactly why they cannot say whether the frames are the right frames. This
// suite closes that: a real `PtyCoreLinkServer` over mTLS, and ports behind it
// that answer the way a Core's own ports do.
//

import { describe, it, expect, afterEach } from "vitest";
import { connectCore } from "../core-connection.ts";
import { EXIT_FAILURE, EXIT_OK } from "../exit-codes.ts";
import {
  makeCliFixture,
  registerCore,
  type CliFixture,
} from "./cli-harness.ts";
import { arrayEventLog, startInProcessCore, type InProcessCore } from "./in-process-core.ts";
import {
  HARNESS_INSTALL_FAILED_EVENT_KIND,
  HARNESSES_AVAILABILITY_EVENT_KIND,
  type CoreLinkHarnessAvailabilityMap,
} from "@actana/sdk/core";
import type {
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
      else log.push("session:updated");
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
      } else log.push("session:updated");
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
