import { describe, expect, it, vi } from "vitest";
import { HarnessInstallService } from "../harness-install-service";
import type { HarnessInstallOutcome } from "@actana/shared/actana-harnesses";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/sdk/core-link-frames";
import type { ActanaSystem } from "@actana/shared/actana-system-port";

// The Core's half of "install this Harness for me" (issue 83). What matters
// here is the verdict: the Panel's row waits on this service saying the Harness
// is available, and nothing else clears it.

const system = {} as ActanaSystem;

function serviceWith(opts: {
  before: CoreLinkHarnessAvailabilityMap;
  after?: CoreLinkHarnessAvailabilityMap;
  outcomes: HarnessInstallOutcome[];
  onInstall?: () => void;
}) {
  let availability = opts.before;
  const reprobe = vi.fn(() => {
    if (opts.after) availability = opts.after;
  });
  const runInstall = vi.fn(async () => {
    opts.onInstall?.();
    return opts.outcomes;
  });
  const service = new HarnessInstallService({
    availability: () => availability,
    reprobe,
    system,
    platform: "linux",
    runInstall,
  });
  return { service, reprobe, runInstall };
}

const MISSING: CoreLinkHarnessAvailabilityMap = { "claude-code": { status: "missing" } };
const AVAILABLE: CoreLinkHarnessAvailabilityMap = {
  "claude-code": { status: "available", path: "/usr/local/bin/claude" },
};

describe("HarnessInstallService", () => {
  describe("installable", () => {
    it("accepts a canonical Harness id and its CLI command", () => {
      const { service } = serviceWith({ before: MISSING, outcomes: [] });
      expect(service.installable("claude-code")).toBe(true);
      expect(service.installable("claude")).toBe(true);
    });

    it("refuses an id this Core does not manage", () => {
      const { service } = serviceWith({ before: MISSING, outcomes: [] });
      expect(service.installable("banana")).toBe(false);
      expect(service.installable("")).toBe(false);
    });
  });

  it("reports ok once the re-probe finds the Harness", async () => {
    const { service, reprobe } = serviceWith({
      before: MISSING,
      after: AVAILABLE,
      outcomes: [{ agent: "claude-code", label: "Claude Code", status: "installed" }],
    });

    await expect(service.install("claude-code")).resolves.toEqual({ ok: true });
    expect(reprobe).toHaveBeenCalledTimes(1);
  });

  it("reports the vendor installer's failure in the operator's language", async () => {
    const { service } = serviceWith({
      before: MISSING,
      outcomes: [{ agent: "claude-code", label: "Claude Code", status: "failed" }],
    });

    const result = await service.install("claude-code");
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("message");
    const { message } = result as { message: string };
    expect(message).toContain("Claude Code");
    expect(message).not.toMatch(/at .*\.ts:\d+/); // a sentence, not a stack trace
  });

  it("treats an install the probe cannot see as a failure, not a success", async () => {
    // The vendor installer exited 0 and put the CLI somewhere this daemon's
    // PATH does not reach. Reporting success would leave the Panel's row
    // waiting for an availability change that is never coming.
    const { service } = serviceWith({
      before: MISSING,
      after: MISSING,
      outcomes: [{ agent: "claude-code", label: "Claude Code", status: "installed" }],
    });

    const result = await service.install("claude-code");
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain("PATH");
  });

  it("points at the vendor's page when there is no scripted installer", async () => {
    const { service } = serviceWith({
      before: MISSING,
      outcomes: [{ agent: "claude-code", label: "Claude Code", status: "unsupported" }],
    });

    const result = await service.install("claude-code");
    expect((result as { message: string }).message).toContain("https://");
  });

  it("refuses an unknown id without running anything", async () => {
    const { service, runInstall } = serviceWith({ before: MISSING, outcomes: [] });

    const result = await service.install("banana");
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain("banana");
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("joins a second request to the install already running", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, runInstall } = serviceWith({
      before: MISSING,
      after: AVAILABLE,
      outcomes: [{ agent: "claude-code", label: "Claude Code", status: "installed" }],
      onInstall: () => {},
    });
    // Hold the first install open while the second arrives.
    const original = runInstall.getMockImplementation()!;
    runInstall.mockImplementation(async (...args: unknown[]) => {
      await gate;
      return (original as (...a: unknown[]) => Promise<HarnessInstallOutcome[]>)(...args);
    });

    const first = service.install("claude-code");
    const second = service.install("claude");
    release();

    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(runInstall).toHaveBeenCalledTimes(1);
  });

  it("takes a fresh request after the previous one finished (retry works)", async () => {
    const { service, runInstall } = serviceWith({
      before: MISSING,
      outcomes: [{ agent: "claude-code", label: "Claude Code", status: "failed" }],
    });

    await service.install("claude-code");
    await service.install("claude-code");
    expect(runInstall).toHaveBeenCalledTimes(2);
  });

  it("turns a thrown installer into a verdict rather than a rejection", async () => {
    const service = new HarnessInstallService({
      availability: () => MISSING,
      reprobe: () => {},
      system,
      platform: "linux",
      runInstall: async () => {
        throw new Error("spawn ENOMEM");
      },
    });

    const result = await service.install("claude-code");
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain("spawn ENOMEM");
  });
});
