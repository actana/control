// The setup check (#685): pre-trust, then start each available Harness once and
// report one that a blocking dialog still stops as needing setup.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/shared/sdk-link-frames";
import { needsSetupDialog } from "@actana/shared/harness-needs-setup";
import { HarnessSetup, type SetupRun } from "../harness-setup";

const TRUST_DIALOG = readFileSync(path.resolve(__dirname, "fixtures/claude-code-2.1.228-folder-trust.txt"), "utf8");
const COMPOSER = readFileSync(path.resolve(__dirname, "fixtures/claude-code-2.1.228-composer.txt"), "utf8");

const claude = (version = "2.1.289") => ({ status: "available" as const, path: "/home/core/.local/bin/claude", version });
const mapOf = (): CoreLinkHarnessAvailabilityMap => ({ "claude-code": claude(), codex: { status: "missing", reason: "not-found" } });

function setup(screens: Record<string, string | Error>) {
  const runs: SetupRun[] = [];
  const pretrust = vi.fn(async () => []);
  const subject = new HarnessSetup({
    workspaces: () => ["/home/core"],
    pretrust,
    runOnce: async (run) => {
      runs.push(run);
      const screen = screens[run.harness] ?? "";
      if (screen instanceof Error) throw screen;
      return screen;
    },
  });
  return { subject, runs, pretrust };
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

  it("starts it again for a new version, and keeps looking at a blocked one every round", async () => {
    const { subject, runs } = setup({ "claude-code": COMPOSER });
    await subject.apply(mapOf());
    await subject.apply({ "claude-code": claude("2.1.300") });
    expect(runs).toHaveLength(2);

    const blocked = setup({ "claude-code": TRUST_DIALOG });
    await blocked.subject.apply(mapOf());
    await blocked.subject.apply(mapOf());
    expect(blocked.runs).toHaveLength(2);
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
    const { subject } = setup(screens);
    expect((await subject.apply(mapOf()))["claude-code"]!.reason).toMatch(/^needs-setup:/);
    screens["claude-code"] = COMPOSER;
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
