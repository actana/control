// #704 cross-check (D2, duplicate dispatch): a SIGHUP that lands while a setup check runs
// is undone when the check finishes. These tests pin the edges of the generation counter
// that 02c4976 (#690) added, beyond the one case its own test covers.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/shared/sdk-link-frames";
import { needsSetupDialog } from "@actana/shared/harness-needs-setup";
import { HarnessSetup, SETUP_RECHECK_BASE_MS, type SetupRun } from "../harness-setup";

const TRUST_DIALOG = readFileSync(path.resolve(__dirname, "fixtures/claude-code-2.1.228-folder-trust.txt"), "utf8");
const COMPOSER = readFileSync(path.resolve(__dirname, "fixtures/claude-code-2.1.228-composer.txt"), "utf8");
const CODEX_TRUST = readFileSync(path.resolve(__dirname, "fixtures/codex-0.153.0-directory-trust.txt"), "utf8");

const claudeOnly = (): CoreLinkHarnessAvailabilityMap => ({
  "claude-code": { status: "available", path: "/home/core/.local/bin/claude", version: "2.1.289" },
});
const both = (): CoreLinkHarnessAvailabilityMap => ({
  ...claudeOnly(),
  codex: { status: "available", path: "/bin/codex", version: "0.160.0" },
});

/** A subject whose first claude-code check stays open until `finish` is called; every other run answers at once. */
function held(screens: Record<string, string>) {
  const runs: SetupRun[] = [];
  const clock = { t: 1_000_000 };
  let finish: (screen: string) => void = () => {};
  let heldOnce = false;
  const subject = new HarnessSetup({
    workspaces: () => ["/home/core"],
    pretrust: async () => [],
    now: () => clock.t,
    runOnce: async (run) => {
      runs.push(run);
      if (run.harness === "claude-code" && !heldOnce) {
        heldOnce = true;
        return new Promise<string>((resolve) => (finish = resolve));
      }
      return screens[run.harness] ?? "";
    },
  });
  return { subject, runs, clock, finish: (screen: string) => finish(screen) };
}

describe("HarnessSetup across a SIGHUP (#704)", () => {
  it("the next look after the dropped result starts a fresh backoff, not a doubled one", async () => {
    const { subject, runs, clock, finish } = held({ "claude-code": TRUST_DIALOG });
    const round = subject.apply(claudeOnly());
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    subject.forgetBlocks();
    finish(TRUST_DIALOG);
    await round;
    await subject.apply(claudeOnly()); // looks again at once: 2 runs, and this block is remembered
    expect(runs).toHaveLength(2);
    clock.t += SETUP_RECHECK_BASE_MS - 1;
    await subject.apply(claudeOnly());
    expect(runs).toHaveLength(2); // inside the base wait: nothing started
    clock.t += 1;
    await subject.apply(claudeOnly());
    expect(runs).toHaveLength(3); // the wait was the base one, not twice it
  });

  it("a check that reaches the composer across the reset is still remembered as a pass", async () => {
    const { subject, runs, finish } = held({});
    const round = subject.apply(claudeOnly());
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    subject.forgetBlocks();
    finish(COMPOSER);
    expect((await round)["claude-code"]!.status).toBe("available");
    expect((await subject.apply(claudeOnly()))["claude-code"]!.status).toBe("available");
    expect(runs).toHaveLength(1);
  });

  it("reads the generation per check: a Harness checked later in the same round, after the reset, is remembered", async () => {
    const { subject, runs, finish } = held({ codex: CODEX_TRUST });
    const round = subject.apply(both());
    await vi.waitFor(() => expect(runs).toHaveLength(1)); // claude-code is on screen, codex not yet started
    subject.forgetBlocks();
    finish(TRUST_DIALOG);
    const out = await round;
    expect(runs.map((r) => r.harness)).toEqual(["claude-code", "codex"]);
    expect(needsSetupDialog(out["claude-code"]!.reason)).toBe("folder-trust");
    expect(needsSetupDialog(out.codex!.reason)).toBe("directory-trust");
    const again = await subject.apply(both());
    // claude-code: its block was from before the reset, so it is started again at once ...
    // codex: its check began after the reset, so its block holds and it is not started again.
    expect(runs.map((r) => r.harness)).toEqual(["claude-code", "codex", "claude-code"]);
    expect(needsSetupDialog(again.codex!.reason)).toBe("directory-trust");
  });

  it("several resets during one check still drop its block, and nothing is remembered from before", async () => {
    const { subject, runs, finish } = held({ "claude-code": TRUST_DIALOG });
    const round = subject.apply(claudeOnly());
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    subject.forgetBlocks();
    subject.forgetBlocks();
    finish(TRUST_DIALOG);
    await round;
    await subject.apply(claudeOnly());
    expect(runs).toHaveLength(2);
  });

  it("a reset that lands between rounds, not during a check, changes nothing about the next look", async () => {
    const { subject, runs, clock, finish } = held({ "claude-code": TRUST_DIALOG });
    const round = subject.apply(claudeOnly());
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    finish(TRUST_DIALOG);
    await round; // remembered: a block with the base wait
    clock.t += SETUP_RECHECK_BASE_MS - 1;
    await subject.apply(claudeOnly());
    expect(runs).toHaveLength(1);
    subject.forgetBlocks(); // SIGHUP with no check running
    await subject.apply(claudeOnly());
    expect(runs).toHaveLength(2);
    await subject.apply(claudeOnly());
    expect(runs).toHaveLength(2); // that look is remembered
  });
});
