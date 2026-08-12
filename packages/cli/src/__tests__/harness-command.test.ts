// `actana harness` — the surface, and above all what `install` exits with (#161).
//
// The ticket's instruction about this verb is unusually specific: report real
// progress and a **real exit status**, and — because #31 and #128 are open, live
// failures rather than history — do not paper over a failed install. So the
// assertions below are mostly about the two ways a command can lie. It must not
// exit 0 on the strength of the ack (the ack means "started", and an installer
// that exits 0 leaving nothing on PATH is a failed install), and when it fails
// it must name the Harness and link the issue.

import { describe, it, expect, afterEach } from "vitest";
import { fakeCore, makeCliFixture, sentinelBlobText, type CliFixture } from "./cli-harness.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../exit-codes.ts";
import {
  HARNESS_INSTALL_FAILED_EVENT_KIND,
  HARNESSES_AVAILABILITY_EVENT_KIND,
  type CoreLinkHarnessAvailabilityMap,
  type CoreLinkRequestFrame,
  type CoreLinkResponseFrame,
} from "@actana/sdk/core-link-frames.ts";

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
  const added = await cli().run(["core", "add", "prod"], { stdin: sentinelBlobText() });
  expect(added.code).toBe(EXIT_OK);
}

/** Let the command's promises run to the point where it is waiting on an event. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const MISSING: CoreLinkHarnessAvailabilityMap = {
  claude: { status: "available", version: "2.1.0", path: "/usr/local/bin/claude", label: "Claude Code" },
  opencode: { status: "missing", reason: "not on PATH", label: "opencode" },
};

/** An ack, and a `dirList`-shaped fallthrough for anything else. */
function acking(accepted: boolean, message?: string) {
  return (frame: CoreLinkRequestFrame): CoreLinkResponseFrame => {
    if (frame.type === "harnessInstall") {
      return message === undefined
        ? { type: "harnessInstallAck", reqId: "r", accepted }
        : { type: "harnessInstallAck", reqId: "r", accepted, message };
    }
    return { type: "error", reqId: "r", message: `unexpected ${frame.type}` };
  };
}

describe("actana harness ls", () => {
  it("emits one row per Harness on stdout, with --json", async () => {
    await withRegisteredCore();
    const core = fakeCore({ availability: MISSING });

    const run = await cli().run(["harness", "ls", "--json"], { connect: core.connect });

    expect(run.code).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload).toEqual([
      expect.objectContaining({ id: "claude", status: "available", version: "2.1.0" }),
      expect.objectContaining({ id: "opencode", status: "missing" }),
    ]);
  });

  it("prints a table when --json is off", async () => {
    await withRegisteredCore();
    const core = fakeCore({ availability: MISSING });

    const run = await cli().run(["harness", "ls"], { connect: core.connect });

    expect(run.out[0]).toContain("HARNESS");
    expect(run.out.join("\n")).toContain("/usr/local/bin/claude");
  });
});

describe("actana harness install", () => {
  it("exits 0 only once the Core reports the Harness available", async () => {
    await withRegisteredCore();
    const core = fakeCore({ availability: MISSING, respond: acking(true) });

    const run = cli().run(["harness", "install", "opencode"], { connect: core.connect });
    await settle();
    core.emitReplayed(7);
    await settle();

    // The ack has been sent and answered. Nothing has been reported yet —
    // "started" is not "installed".
    core.emitEvent({
      eventId: 8,
      kind: HARNESSES_AVAILABILITY_EVENT_KIND,
      payload: JSON.stringify({
        ...MISSING,
        opencode: { status: "available", version: "0.5.0", path: "/root/.opencode/bin/opencode" },
      }),
    });

    const result = await run;
    expect(result.code).toBe(EXIT_OK);
    expect(result.out.join("\n")).toContain("Installed opencode");
    expect(result.out.join("\n")).toContain("/root/.opencode/bin/opencode");
    expect(core.closed).toBe(true);
  });

  it("fails, names the Harness and links the issue when the Core reports a failure", async () => {
    await withRegisteredCore();
    const core = fakeCore({ availability: MISSING, respond: acking(true) });

    const run = cli().run(["harness", "install", "opencode"], { connect: core.connect });
    await settle();
    core.emitReplayed(7);
    await settle();
    core.emitEvent({
      eventId: 8,
      kind: HARNESS_INSTALL_FAILED_EVENT_KIND,
      payload: JSON.stringify({
        harness: "opencode",
        message: "opencode was installed, but `opencode` is still not on this Core's PATH.",
      }),
    });

    const result = await run;
    expect(result.code).toBe(EXIT_FAILURE);
    const said = result.err.join("\n");
    expect(said).toContain("opencode is not installed");
    expect(said).toContain("still not on this Core's PATH");
    // #31 for opencode specifically, #128 for the install path in general.
    expect(said).toContain("/issues/31");
    expect(said).toContain("/issues/128");
    // Nothing on stdout claiming otherwise.
    expect(result.out).toEqual([]);
  });

  it("ignores an outcome from before it asked", async () => {
    await withRegisteredCore();
    const core = fakeCore({ availability: MISSING, respond: acking(true) });

    const run = cli().run(["harness", "install", "opencode", "--json"], { connect: core.connect });
    await settle();
    // The replay tail's marker: everything at or below #7 happened earlier,
    // including — as here — a failure from an install an hour ago.
    core.emitReplayed(7);
    await settle();
    core.emitEvent({
      eventId: 5,
      kind: HARNESS_INSTALL_FAILED_EVENT_KIND,
      payload: JSON.stringify({ harness: "opencode", message: "an install from an hour ago" }),
    });
    await settle();
    core.emitEvent({
      eventId: 9,
      kind: HARNESSES_AVAILABILITY_EVENT_KIND,
      payload: JSON.stringify({ opencode: { status: "available", version: "0.6.0" } }),
    });

    const result = await run;
    expect(result.code).toBe(EXIT_OK);
    const payload = JSON.parse(result.out.join("\n"));
    expect(payload.installed).toBe(true);
    expect(payload.message).toBeNull();
  });

  it("subscribes before it asks, so no outcome can land in the gap", async () => {
    await withRegisteredCore();
    const core = fakeCore({ availability: MISSING, respond: acking(true) });

    const run = cli().run(["harness", "install", "opencode"], { connect: core.connect });
    await settle();
    // The subscribe has gone out and the install frame has not: the command is
    // waiting for the marker that tells it where the log ends.
    expect(core.subscribes).toEqual([0]);
    expect(core.requests.filter((f) => f.type === "harnessInstall")).toHaveLength(0);

    core.emitReplayed(7);
    await settle();
    expect(core.requests.filter((f) => f.type === "harnessInstall")).toHaveLength(1);

    core.emitEvent({
      eventId: 8,
      kind: HARNESSES_AVAILABILITY_EVENT_KIND,
      payload: JSON.stringify({ opencode: { status: "available" } }),
    });
    await run;
  });

  it("reports a refusal to start without waiting for an outcome", async () => {
    await withRegisteredCore();
    const core = fakeCore({
      availability: MISSING,
      respond: acking(false, "Actana does not know how to install `nosuch`."),
    });

    const run = cli().run(["harness", "install", "nosuch"], { connect: core.connect });
    await settle();
    core.emitReplayed(7);

    const result = await run;
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err.join("\n")).toContain("does not know how to install");
  });

  it("says so, and exits 0, when the Harness is already there", async () => {
    await withRegisteredCore();
    const core = fakeCore({ availability: MISSING, respond: acking(true) });

    const run = await cli().run(["harness", "install", "claude"], { connect: core.connect });

    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("already on");
    // Nothing was installed, so nothing was asked for.
    expect(core.requests.filter((f) => f.type === "harnessInstall")).toHaveLength(0);
  });

  it("keeps progress off stdout, so --json stays parseable", async () => {
    await withRegisteredCore();
    const core = fakeCore({ availability: MISSING, respond: acking(true) });

    const run = cli().run(["harness", "install", "opencode", "--json"], { connect: core.connect });
    await settle();
    core.emitReplayed(7);
    await settle();
    core.emitEvent({
      eventId: 8,
      kind: HARNESS_INSTALL_FAILED_EVENT_KIND,
      payload: JSON.stringify({ harness: "opencode", message: "no" }),
    });

    const result = await run;
    // The "Installing …" progress lines exist and are on stderr; stdout is one
    // JSON object and nothing else.
    expect(result.err.join("\n")).toContain("Installing opencode");
    const payload = JSON.parse(result.out.join("\n"));
    expect(payload.installed).toBe(false);
    expect(payload.issue).toContain("/issues/31");
  });

  it("needs an id", async () => {
    await withRegisteredCore();
    const run = await cli().run(["harness", "install"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("harness ls");
  });
});
