// The setup check (#685): pre-trust, then start each available Harness once and
// report one that a blocking dialog still stops as needing setup.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/shared/sdk-link-frames";
import { needsSetupDialog } from "@actana/shared/harness-needs-setup";
import { matchBlockingDialog } from "../harness-prompt-delivery";
import { HarnessSetup, SETUP_ONLY_DIALOGS, SETUP_RECHECK_BASE_MS, SETUP_RECHECK_MAX_MS, type SetupRun } from "../harness-setup";

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
    const codex = { codex: { status: "available" as const, path: "/bin/codex", version: "0.153.0" } };
    const blocked = await setup({ codex: dialog }).subject.apply(codex);
    expect(needsSetupDialog(blocked.codex!.reason)).toBe("directory-trust");
    expect((await setup({ codex: composer }).subject.apply(codex)).codex!.status).toBe("available");
  });

  // codex-cli 0.160.0, captured live at 120x40 the way the setup check starts it (no prompt, no flags) in a
  // throwaway home: the reworded "Folder access / Trust this folder?" dialog in an untrusted git repository, the
  // composer in the same repository after `trustCodex` wrote `[projects."<dir>"] trust_level = "trusted"`, and the
  // composer in a plain directory, where 0.160.0 asks nothing (#702).
  const codex160 = (fixture: string) => readFileSync(path.resolve(__dirname, `fixtures/codex-0.160.0-${fixture}.txt`), "utf8");
  const codex160Entry = { codex: { status: "available" as const, path: "/home/core/.local/bin/codex", version: "0.160.0" } };

  it("recognises codex 0.160.0's reworded folder-trust dialog (#702)", async () => {
    const out = await setup({ codex: codex160("folder-trust") }).subject.apply(codex160Entry);
    expect(out.codex!.status).toBe("missing");
    expect(needsSetupDialog(out.codex!.reason)).toBe("directory-trust");
    // The menu itself ("1. Trust and continue" / "2. Back to Agent Command Center") is laid out with absolute cursor
    // moves, which `readDialogOptions` cannot read on codex (issue 469); the setup check needs only the match.
    expect(matchBlockingDialog(codex160("folder-trust"), SETUP_ONLY_DIALOGS)?.spec.id).toBe("directory-trust");
  });

  it("reports codex 0.160.0 available once the projects writer has recorded the repository (#702)", async () => {
    const out = await setup({ codex: codex160("trusted-boot") }).subject.apply(codex160Entry);
    expect(out.codex!.status).toBe("available");
    expect(matchBlockingDialog(codex160("trusted-boot"), SETUP_ONLY_DIALOGS)).toBeNull();
  });

  it("reports codex 0.160.0 available in a plain directory, where it opens no dialog (#702)", async () => {
    const out = await setup({ codex: codex160("plain-dir-boot") }).subject.apply(codex160Entry);
    expect(out.codex!.status).toBe("available");
  });

  it("clears the report once the dialog is gone", async () => {
    const screens: Record<string, string> = { "claude-code": TRUST_DIALOG };
    const { subject, clock } = setup(screens);
    expect((await subject.apply(mapOf()))["claude-code"]!.reason).toMatch(/^needs-setup:/);
    screens["claude-code"] = COMPOSER;
    clock.t += SETUP_RECHECK_BASE_MS;
    expect((await subject.apply(mapOf()))["claude-code"]!.status).toBe("available");
  });

  it("does not call a Harness that could not be started needs-setup", async () => {
    const { subject } = setup({ "claude-code": new Error("posix_spawnp failed") });
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
});
