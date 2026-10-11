// The setup check (#685): pre-trust, then start each available Harness once and
// report one that a blocking dialog still stops as needing setup.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/shared/sdk-link-frames";
import { needsSetupDialog, setupCheckFailure } from "@actana/shared/harness-needs-setup";
import { HarnessSetup, SETUP_RECHECK_BASE_MS, SETUP_RECHECK_MAX_MS, type SetupRun } from "../harness-setup";

const TRUST_DIALOG = readFileSync(path.resolve(__dirname, "fixtures/claude-code-2.1.228-folder-trust.txt"), "utf8");
const COMPOSER = readFileSync(path.resolve(__dirname, "fixtures/claude-code-2.1.228-composer.txt"), "utf8");

const claude = (version = "2.1.289") => ({ status: "available" as const, path: "/home/core/.local/bin/claude", version });
const mapOf = (): CoreLinkHarnessAvailabilityMap => ({ "claude-code": claude(), codex: { status: "missing", reason: "not-found" } });

function setup(screens: Record<string, string | Error>) {
  const runs: SetupRun[] = [];
  const clock = { t: 1_000_000 };
  const pretrust = vi.fn(async () => []);
  const subject = new HarnessSetup({
    workspaces: () => ["/home/core"],
    pretrust,
    now: () => clock.t,
    runOnce: async (run) => {
      runs.push(run);
      const screen = screens[run.harness] ?? "";
      if (screen instanceof Error) throw screen;
      return screen;
    },
  });
  return { subject, runs, pretrust, clock };
}

describe("HarnessSetup", () => {
  it("reports a Harness still at its folder-trust dialog as needing setup, and names the dialog", async () => {
    const { subject, runs } = setup({ "claude-code": TRUST_DIALOG });
    const out = await subject.apply(mapOf());
    expect(runs).toEqual([{ harness: "claude-code", binary: "/home/core/.local/bin/claude", cwd: "/home/core" }]);
    expect(out["claude-code"]!.status).toBe("missing");
    expect(needsSetupDialog(out["claude-code"]!.reason)).toBe("folder-trust");
    expect(out["claude-code"]!.version).toBe("2.1.289");
    expect(out.codex).toEqual({ status: "missing", reason: "not-found" });
  });

  it("leaves a Harness that reaches its composer available, and does not start it again", async () => {
    const { subject, runs } = setup({ "claude-code": COMPOSER });
    expect((await subject.apply(mapOf()))["claude-code"]!.status).toBe("available");
    expect((await subject.apply(mapOf()))["claude-code"]!.status).toBe("available");
    expect(runs).toHaveLength(1);
  });

  it("starts it again for a new version, and keeps looking at a blocked one, backing off between looks", async () => {
    const { subject, runs } = setup({ "claude-code": COMPOSER });
    await subject.apply(mapOf());
    await subject.apply({ "claude-code": claude("2.1.300") });
    expect(runs).toHaveLength(2);

    const blocked = setup({ "claude-code": TRUST_DIALOG });
    await blocked.subject.apply(mapOf());
    // Rounds inside the backoff start nothing and still report what it showed.
    blocked.clock.t += SETUP_RECHECK_BASE_MS - 1;
    const waiting = await blocked.subject.apply(mapOf());
    expect(blocked.runs).toHaveLength(1);
    expect(needsSetupDialog(waiting["claude-code"]!.reason)).toBe("folder-trust");
    blocked.clock.t += 1;
    await blocked.subject.apply(mapOf());
    expect(blocked.runs).toHaveLength(2);
  });

  it("doubles the wait while still blocked, up to the cap, and starts at once for a new version", async () => {
    const { subject, runs, clock } = setup({ "claude-code": TRUST_DIALOG });
    await subject.apply(mapOf());
    clock.t += SETUP_RECHECK_BASE_MS;
    await subject.apply(mapOf());
    expect(runs).toHaveLength(2);
    clock.t += SETUP_RECHECK_BASE_MS; // the second wait is twice as long
    await subject.apply(mapOf());
    expect(runs).toHaveLength(2);
    clock.t += SETUP_RECHECK_BASE_MS;
    await subject.apply(mapOf());
    expect(runs).toHaveLength(3);
    for (let i = 0; i < 6; i += 1) {
      clock.t += SETUP_RECHECK_MAX_MS;
      await subject.apply(mapOf());
    }
    expect(runs).toHaveLength(9); // never longer than the cap between looks
    await subject.apply({ "claude-code": claude("3.0.0") });
    expect(runs).toHaveLength(10);
  });

  it("looks at a blocked Harness again at once after forgetBlocks (SIGHUP), inside its backoff", async () => {
    const { subject, runs } = setup({ "claude-code": TRUST_DIALOG });
    await subject.apply(mapOf());
    await subject.apply(mapOf());
    expect(runs).toHaveLength(1);
    subject.forgetBlocks();
    await subject.apply(mapOf());
    expect(runs).toHaveLength(2);
  });

  it("remembers no block from a check that was already running when forgetBlocks arrived (#690, #704)", async () => {
    const runs: SetupRun[] = [];
    let finish: (screen: string) => void = () => {};
    const subject = new HarnessSetup({
      workspaces: () => ["/home/core"],
      pretrust: async () => [],
      runOnce: async (run) => {
        runs.push(run);
        return runs.length === 1 ? new Promise<string>((resolve) => (finish = resolve)) : TRUST_DIALOG;
      },
    });
    const round = subject.apply(mapOf());
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    subject.forgetBlocks(); // SIGHUP lands while the Harness is still painting
    finish(TRUST_DIALOG);
    // This round still says what the screen showed ...
    expect(needsSetupDialog((await round)["claude-code"]!.reason)).toBe("folder-trust");
    // ... but the next round starts it again at once instead of sitting inside a backoff the reset was meant to clear.
    expect(needsSetupDialog((await subject.apply(mapOf()))["claude-code"]!.reason)).toBe("folder-trust");
    expect(runs).toHaveLength(2);
    // That look, after the reset, is remembered as usual.
    await subject.apply(mapOf());
    expect(runs).toHaveLength(2);
  });

  it("does not call Pi blocked at its trust screen: its extension answers that in a real Session (#686 review)", async () => {
    const trust = readFileSync(path.resolve(__dirname, "fixtures/pi-0.85.1-project-trust.txt"), "utf8");
    const { subject, runs } = setup({ pi: trust });
    const out = await subject.apply({ pi: { status: "available", path: "/bin/pi", version: "1.0.2" } });
    expect(runs).toHaveLength(1);
    expect(out.pi!.status).toBe("available");
  });

  it("still reports Pi's no-models screen as needing setup", async () => {
    const noModels = readFileSync(path.resolve(__dirname, "fixtures/pi-0.85.1-composer.txt"), "utf8");
    const out = await setup({ pi: noModels }).subject.apply({ pi: { status: "available", path: "/bin/pi" } });
    expect(needsSetupDialog(out.pi!.reason)).toBe("no-models");
  });

  it("recognises codex's real directory-trust dialog, and not its composer (#685)", async () => {
    const dialog = readFileSync(path.resolve(__dirname, "fixtures/codex-0.153.0-directory-trust.txt"), "utf8");
    const composer = readFileSync(path.resolve(__dirname, "fixtures/codex-0.153.0-composer.txt"), "utf8");
    const codex = { codex: { status: "available" as const, path: "/bin/codex", version: "0.160.0" } };
    const blocked = await setup({ codex: dialog }).subject.apply(codex);
    expect(needsSetupDialog(blocked.codex!.reason)).toBe("directory-trust");
    expect((await setup({ codex: composer }).subject.apply(codex)).codex!.status).toBe("available");
  });

  it("clears the report once the dialog is gone", async () => {
    const screens: Record<string, string> = { "claude-code": TRUST_DIALOG };
    const { subject, clock } = setup(screens);
    expect((await subject.apply(mapOf()))["claude-code"]!.reason).toMatch(/^needs-setup:/);
    screens["claude-code"] = COMPOSER;
    clock.t += SETUP_RECHECK_BASE_MS;
    expect((await subject.apply(mapOf()))["claude-code"]!.status).toBe("available");
  });


  it("pre-trusts only the available Harnesses that have a writer, before starting anything", async () => {
    const { subject, pretrust } = setup({});
    await subject.apply({
      "claude-code": claude(),
      codex: { status: "available", path: "/bin/codex" },
      pi: { status: "available", path: "/bin/pi" },
      opencode: { status: "missing" },
    });
    expect(pretrust).toHaveBeenCalledWith(["claude-code", "codex"], ["/home/core"]);
  });

  it("still runs the check when the pre-trust write fails", async () => {
    const runs: SetupRun[] = [];
    const subject = new HarnessSetup({
      workspaces: () => ["/home/core"],
      pretrust: async () => {
        throw new Error("EACCES");
      },
      runOnce: async (run) => (runs.push(run), TRUST_DIALOG),
    });
    const out = await subject.apply(mapOf());
    expect(runs).toHaveLength(1);
    expect(needsSetupDialog(out["claude-code"]!.reason)).toBe("folder-trust");
  });

  it("does nothing when no Harness is available", async () => {
    const { subject, runs, pretrust } = setup({});
    const input: CoreLinkHarnessAvailabilityMap = { codex: { status: "missing" } };
    expect(await subject.apply(input)).toBe(input);
    expect(runs).toEqual([]);
    expect(pretrust).not.toHaveBeenCalled();
  });

  describe("a Harness the check cannot start (#700)", () => {
    const failing = () => setup({ "claude-code": new Error("posix_spawnp failed: EACCES") });

    it("is not announced available: it is reported as a failed check naming the error, not as a dialog", async () => {
      const { subject, runs } = failing();
      const out = await subject.apply(mapOf());
      expect(runs).toHaveLength(1);
      expect(out["claude-code"]!.status).toBe("missing");
      expect(setupCheckFailure(out["claude-code"]!.reason)).toBe("posix_spawnp failed: EACCES");
      expect(needsSetupDialog(out["claude-code"]!.reason)).toBeNull();
      // The probe's facts travel with it, so the Panel still knows the binary and version.
      expect(out["claude-code"]!.path).toBe("/home/core/.local/bin/claude");
      expect(out["claude-code"]!.version).toBe("2.1.289");
      expect(out.codex).toEqual({ status: "missing", reason: "not-found" });
    });

    it("is looked at again with the same backoff as a block, and reports the last failure meanwhile", async () => {
      const { subject, runs, clock } = failing();
      await subject.apply(mapOf());
      clock.t += SETUP_RECHECK_BASE_MS - 1;
      const waiting = await subject.apply(mapOf());
      expect(runs).toHaveLength(1);
      expect(setupCheckFailure(waiting["claude-code"]!.reason)).toBe("posix_spawnp failed: EACCES");
      clock.t += 1;
      await subject.apply(mapOf());
      expect(runs).toHaveLength(2);
      clock.t += SETUP_RECHECK_BASE_MS; // the second wait is twice as long
      await subject.apply(mapOf());
      expect(runs).toHaveLength(2);
      clock.t += SETUP_RECHECK_BASE_MS;
      await subject.apply(mapOf());
      expect(runs).toHaveLength(3);
      for (let i = 0; i < 6; i += 1) {
        clock.t += SETUP_RECHECK_MAX_MS;
        await subject.apply(mapOf());
      }
      expect(runs).toHaveLength(9); // never longer than the cap between looks
    });

    it("shares one backoff with a block: a dialog after a failed start doubles the wait, not resets it", async () => {
      const screens: Record<string, string | Error> = { "claude-code": new Error("spawn EAGAIN") };
      const { subject, runs, clock } = setup(screens);
      await subject.apply(mapOf());
      screens["claude-code"] = TRUST_DIALOG;
      clock.t += SETUP_RECHECK_BASE_MS;
      const blocked = await subject.apply(mapOf());
      expect(runs).toHaveLength(2);
      expect(needsSetupDialog(blocked["claude-code"]!.reason)).toBe("folder-trust");
      clock.t += SETUP_RECHECK_BASE_MS;
      expect(needsSetupDialog((await subject.apply(mapOf()))["claude-code"]!.reason)).toBe("folder-trust");
      expect(runs).toHaveLength(2);
      clock.t += SETUP_RECHECK_BASE_MS;
      await subject.apply(mapOf());
      expect(runs).toHaveLength(3);
    });

    it("is available once a look reaches the composer, and is then remembered as a pass", async () => {
      const screens: Record<string, string | Error> = { "claude-code": new Error("spawn EAGAIN") };
      const { subject, runs, clock } = setup(screens);
      expect((await subject.apply(mapOf()))["claude-code"]!.status).toBe("missing");
      screens["claude-code"] = COMPOSER;
      clock.t += SETUP_RECHECK_BASE_MS;
      expect((await subject.apply(mapOf()))["claude-code"]!.status).toBe("available");
      expect((await subject.apply(mapOf()))["claude-code"]!.status).toBe("available");
      expect(runs).toHaveLength(2);
    });

    it("is looked at again at once after forgetBlocks (SIGHUP) or for a new version, inside its backoff", async () => {
      const { subject, runs } = failing();
      await subject.apply(mapOf());
      await subject.apply(mapOf());
      expect(runs).toHaveLength(1);
      subject.forgetBlocks();
      await subject.apply(mapOf());
      expect(runs).toHaveLength(2);
      await subject.apply({ "claude-code": claude("2.1.300") });
      expect(runs).toHaveLength(3);
    });

    it("remembers no failed start from a check that was already running when forgetBlocks arrived", async () => {
      const runs: SetupRun[] = [];
      let fail: (error: Error) => void = () => {};
      const subject = new HarnessSetup({
        workspaces: () => ["/home/core"],
        pretrust: async () => [],
        runOnce: async (run) => {
          runs.push(run);
          return new Promise<string>((_resolve, reject) => (fail = reject));
        },
      });
      const round = subject.apply(mapOf());
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      subject.forgetBlocks(); // SIGHUP lands while the start is still in flight
      fail(new Error("spawn EAGAIN"));
      // This round still reports the failed start ...
      const reported = (await round)["claude-code"]!;
      expect(reported.status).toBe("missing");
      expect(setupCheckFailure(reported.reason)).toBe("spawn EAGAIN");
      // ... but the next round starts it again at once instead of sitting inside the backoff.
      const again = subject.apply(mapOf());
      await vi.waitFor(() => expect(runs).toHaveLength(2));
      fail(new Error("spawn EAGAIN"));
      await again;
    });

    it("does not take back a pass: a Harness that reached its composer is not started again, so a later start failure cannot be seen", async () => {
      const screens: Record<string, string | Error> = { "claude-code": COMPOSER };
      const { subject, runs } = setup(screens);
      await subject.apply(mapOf());
      screens["claude-code"] = new Error("spawn EAGAIN");
      expect((await subject.apply(mapOf()))["claude-code"]!.status).toBe("available");
      expect(runs).toHaveLength(1);
    });
  });
});
