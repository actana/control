import { describe, expect, it } from "vitest";

import { hostTarget, pickTarball, rehearsalOneLiner } from "../lib/rehearsal.mjs";

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
    "actana-harness-0.49.0-linux-x64.tar.gz",
    "actana-harness-0.50.0-linux-x64.tar.gz",
    "actana-harness-0.51.0-linux-arm64.tar.gz",
    "SHA256SUMS",
    "notes.txt",
  ];

  it("picks the newest release built for the machine running the rehearsal", () => {
    expect(pickTarball(files, "linux-x64", () => {})).toBe(
      "actana-harness-0.50.0-linux-x64.tar.gz",
    );
  });

  it("never hands back another architecture's tarball", () => {
    expect(pickTarball(files, "linux-arm64", () => {})).toBe(
      "actana-harness-0.51.0-linux-arm64.tar.gz",
    );
  });

  it("compares versions numerically, not as strings", () => {
    const numeric = ["actana-harness-0.9.0-linux-x64.tar.gz", "actana-harness-0.10.0-linux-x64.tar.gz"];
    expect(pickTarball(numeric, "linux-x64", () => {})).toBe(
      "actana-harness-0.10.0-linux-x64.tar.gz",
    );
  });

  it("says how to produce one when there is nothing to rehearse against", () => {
    const message = captureFailure((fail) => pickTarball(["SHA256SUMS"], "linux-x64", fail));
    expect(message).toMatch(/linux-x64/);
    expect(message).toMatch(/harness:tarball/);
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
    expect(command).not.toMatch(/--yes|--no-agents|--with-/);
  });
});
