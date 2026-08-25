import { describe, expect, it } from "vitest";

import {
  hostTarget,
  pickTarball,
  rehearsalOneLiner,
  rehearsalSetupCommand,
} from "../lib/rehearsal.mjs";

import { captureFailure } from "./capture-failure.mjs";

describe("hostTarget", () => {
  it("maps the host architecture onto the release target it can run", () => {
    expect(hostTarget("x64", () => {})).toBe("linux-x64");
    expect(hostTarget("arm64", () => {})).toBe("linux-arm64");
  });

  it("refuses an architecture the release has no Linux build for", () => {
    const message = captureFailure((fail) => hostTarget("ia32", fail));
    expect(message).toMatch(/ia32/);
  });
});

describe("pickTarball", () => {
  const files = [
    "actana-core-0.1.0-linux-x64.tar.gz",
    "actana-core-0.2.0-linux-x64.tar.gz",
    "actana-core-0.3.0-linux-arm64.tar.gz",
    "SHA256SUMS",
    "notes.txt",
  ];

  it("picks the newest release built for the machine running the rehearsal", () => {
    expect(pickTarball(files, "linux-x64", () => {})).toBe(
      "actana-core-0.2.0-linux-x64.tar.gz",
    );
  });

  it("never hands back another architecture's tarball", () => {
    expect(pickTarball(files, "linux-arm64", () => {})).toBe(
      "actana-core-0.3.0-linux-arm64.tar.gz",
    );
  });

  it("compares versions numerically, not as strings", () => {
    const numeric = ["actana-core-0.9.0-linux-x64.tar.gz", "actana-core-0.10.0-linux-x64.tar.gz"];
    expect(pickTarball(numeric, "linux-x64", () => {})).toBe(
      "actana-core-0.10.0-linux-x64.tar.gz",
    );
  });

  it("says how to produce one when there is nothing to rehearse against", () => {
    const message = captureFailure((fail) => pickTarball(["SHA256SUMS"], "linux-x64", fail));
    expect(message).toMatch(/linux-x64/);
    expect(message).toMatch(/core:tarball/);
  });
});

describe("rehearsalOneLiner", () => {
  const url = "http://host.docker.internal:8788";

  it("is the command the docs print, pointed at the fixture release server", () => {
    const command = rehearsalOneLiner(url);
    expect(command).toBe(`curl -fsSL ${url}/install.sh | bash -s -- --base-url ${url}`);
  });

  it("passes nothing that suppresses a prompt — the prompts are the rehearsal", () => {
    const command = rehearsalOneLiner(url);
    expect(command).not.toMatch(/--yes|--no-harnesses|--with-/);
  });

  // Since #316 those flags are not merely unwanted here: `install.sh` refuses
  // them, so a one-liner carrying one would end the rehearsal at the first
  // paste. This is the same claim as the test above, bound to the script's
  // own option list rather than to a preference.
  it("carries only options `install.sh` still owns", () => {
    const flags = rehearsalOneLiner(url).match(/--[a-z-]+/g) ?? [];
    for (const flag of flags) {
      expect(["--base-url"], `${flag} is not an installer option`).toContain(flag);
    }
  });
});

describe("rehearsalSetupCommand", () => {
  // The rehearsal is two commands now — install is not activation (ADR 0036
  // C2). A rehearsal that printed only the first would stall at an installed
  // machine with nothing running on it, which is exactly what the operator
  // is there to avoid discovering in production.
  it("is the second command, and it is the one with the prompts in it", () => {
    expect(rehearsalSetupCommand()).toBe("actana setup");
  });

  it("suppresses no prompt either", () => {
    expect(rehearsalSetupCommand()).not.toMatch(/--yes|--no-harnesses|--with-/);
  });
});
