import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreChildEnv, coreIdentity } from "@actana/shared/core-home";
import { HarnessAvailabilityStore } from "@actana/shared/harness-availability-store";
import { coreAvailabilityProbe } from "../harness-availability-probe";
import { inProcessHelper } from "./core-home-ops-kit";

// #559 (release 552's e2e run): "Claude Code was installed, but claude is still not
// on this Core's PATH". In the container the daemon is `actana`, core's home is
// 0750 core:core, and the probe looked up the CLI from the daemon's own process, so
// every `stat` in the home failed and nothing installed there was ever found. The
// probe now asks `core` (the helper), the way a Session's spawn already does. These
// tests run the helper's real code against a real home with fake CLIs in it, and
// the daemon-side lookup is made blind to that home to stand in for the 0750 mode.

const CONTAINER = (home: string) => ({ AC_CORE_HOME: home, AC_CORE_UID: "1000", AC_CORE_GID: "1000" });

let home: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "actana-probe-")));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function plant(dir: string, name: string, version = "99.0.0"): string {
  const full = path.join(home, dir);
  fs.mkdirSync(full, { recursive: true });
  const file = path.join(full, name);
  fs.writeFileSync(file, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return file;
}

function containerProbe() {
  const identityEnv = CONTAINER(home);
  const identity = coreIdentity(identityEnv)!;
  const helper = inProcessHelper(home);
  const probe = coreAvailabilityProbe(
    { ...helper.options, identityEnv },
    () => coreChildEnv(identity, { PATH: "/usr/bin:/bin" }, {}),
  );
  return { probe: probe!, helper };
}

describe("coreAvailabilityProbe", () => {
  it("is undefined outside the container, where the in-process probe is right", () => {
    expect(coreAvailabilityProbe({ identityEnv: {} })).toBeUndefined();
  });

  it("finds a claude installed in core's ~/.local/bin", async () => {
    const file = plant(".local/bin", "claude");
    const { probe } = containerProbe();
    const found = await probe("claude-code");
    expect(found).toMatchObject({ status: "available", path: file, version: "99.0.0" });
  });

  it("finds an opencode installed in ~/.opencode/bin, a directory only the registry names", async () => {
    const file = plant(".opencode/bin", "opencode");
    const { probe } = containerProbe();
    expect(await probe("opencode")).toMatchObject({ status: "available", path: file });
  });

  it("says missing for a Harness that is not there, and asks core rather than looking itself", async () => {
    const { probe, helper } = containerProbe();
    expect(await probe("claude-code")).toEqual({ status: "missing", reason: "not-found" });
    expect(helper.requests.length).toBeGreaterThan(0);
    expect(helper.requests.every((entry) => entry.request.op === "probeHarnessCli")).toBe(true);
    const searched = helper.requests.map((entry) => (entry.request as { path: string | null }).path ?? "");
    expect(searched[0]?.split(":")).toEqual(
      expect.arrayContaining([`${home}/.local/bin`, `${home}/.opencode/bin`]),
    );
  });

  it("drives the availability store end to end", async () => {
    plant(".local/bin", "claude");
    const { probe } = containerProbe();
    const store = new HarnessAvailabilityStore({ appendEvent: () => 1, probeAsync: probe });
    await store.refresh();
    expect(store.snapshot()["claude-code"]?.status).toBe("available");
  });

  // The daemon is not core and cannot signal it, so a synchronous `--version` of a file
  // core controls could not be interrupted: a wrapper that hangs there held the daemon's
  // event loop on every tick. The probe must never run one itself; core's helper does.
  it("never runs a binary from core's home in the daemon, whatever the helper says", async () => {
    const marker = path.join(home, "ran-in-daemon");
    const file = path.join(home, ".local", "bin", "claude");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\necho ran >> ${marker}\necho 99.0.0\n`, { mode: 0o755 });
    const identityEnv = CONTAINER(home);
    const identity = coreIdentity(identityEnv)!;
    const probe = coreAvailabilityProbe(
      {
        identityEnv,
        // The helper's answer, as core would give it: found, and checked there.
        run: async () => ({
          status: 0,
          stdout: `${JSON.stringify({ ok: true, result: { candidates: [file], meeting: { binary: file, check: { ok: true, version: "99.0.0" } } } })}\n`,
          stderr: "",
        }),
      },
      () => coreChildEnv(identity, { PATH: "/usr/bin:/bin" }, {}),
    )!;
    expect(await probe("claude-code")).toMatchObject({ status: "available", path: file, version: "99.0.0" });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("takes only a path it was offered and a verdict from the helper's answer", async () => {
    const identityEnv = CONTAINER(home);
    const identity = coreIdentity(identityEnv)!;
    const probe = coreAvailabilityProbe(
      {
        identityEnv,
        run: async () => ({
          status: 0,
          stdout: `${JSON.stringify({ ok: true, result: { candidates: ["/home/x/claude"], meeting: { binary: "/etc/shadow", check: { ok: true, version: "9" } } } })}\n`,
          stderr: "",
        }),
      },
      () => coreChildEnv(identity, { PATH: "/usr/bin:/bin" }, {}),
    )!;
    expect(await probe("claude-code")).toEqual({ status: "missing", reason: "not-found" });
  });
});
