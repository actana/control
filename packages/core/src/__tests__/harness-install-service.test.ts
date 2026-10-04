import { describe, expect, it, vi } from "vitest";
import { HarnessInstallService, profileHomeDir } from "../harness-install-service";
import type { HarnessInstallOutcome } from "@actana/shared/actana-harnesses";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/sdk/core";
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

  it("reports ok when the installed Harness stops at a first-run dialog (needs setup)", async () => {
    // Pi with no model: the CLI is on PATH and runs, so the install worked; the
    // setup is finished in a Session, not reported as "not on PATH".
    const { service } = serviceWith({
      before: MISSING,
      after: { "claude-code": { status: "missing", reason: "needs-setup: no-models", path: "/usr/local/bin/claude" } },
      outcomes: [{ agent: "claude-code", label: "Claude Code", status: "installed" }],
    });

    await expect(service.install("claude-code")).resolves.toEqual({ ok: true });
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

// #559: the daemon is `actana` in the container and core's home is 0750 core:core, so the
// managed login-PATH block could only fail there ("could not write ~/.profile"). It is
// written on metal, where the daemon owns the home, and never in the container.
describe("profileHomeDir", () => {
  const CONTAINER = { AC_CORE_HOME: "/home/core", AC_CORE_UID: "1000", AC_CORE_GID: "1000" };

  it("keeps the home outside the container", () => {
    expect(profileHomeDir("/home/dev", {})).toBe("/home/dev");
  });

  it("drops the home in the container, so no profile is written", () => {
    expect(profileHomeDir("/home/core", CONTAINER)).toBeUndefined();
  });

  it("hands the installer no home in the container", async () => {
    vi.stubEnv("AC_CORE_HOME", CONTAINER.AC_CORE_HOME);
    vi.stubEnv("AC_CORE_UID", CONTAINER.AC_CORE_UID);
    vi.stubEnv("AC_CORE_GID", CONTAINER.AC_CORE_GID);
    try {
      const seen: Array<string | undefined> = [];
      const service = new HarnessInstallService({
        availability: () => AVAILABLE,
        reprobe: () => undefined,
        system,
        platform: "linux",
        homeDir: "/home/core",
        runInstall: async (_agents, context) => {
          seen.push(context.homeDir);
          return [{ agent: "claude-code", status: "installed" } as HarnessInstallOutcome];
        },
      });
      await service.install("claude-code");
      expect(seen).toEqual([undefined]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("HarnessInstallService re-probe", () => {
  it("waits for an asynchronous re-probe before judging", async () => {
    let availability = MISSING;
    const service = new HarnessInstallService({
      availability: () => availability,
      reprobe: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        availability = AVAILABLE;
      },
      system,
      platform: "linux",
      runInstall: async () => [{ agent: "claude-code", status: "installed" } as HarnessInstallOutcome],
    });
    await expect(service.install("claude-code")).resolves.toEqual({ ok: true });
  });
});
