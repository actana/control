// The one decision `scripts/lib/setup-e2e.mjs` makes without a machine in
// front of it: reading the `actana setup` command out of what the installer
// printed.
//
// It is tested here rather than only inside the container e2e because the
// container e2e cannot fail *usefully* on it — a bad extraction there shows up
// as "`ctana setup --public-host 127.0.0.1`: command not found" twenty minutes
// into a run, or worse, as a run that silently never activates the machine and
// then fails on an assertion three screens later.

import { describe, expect, it } from "vitest";

import { nextSetupCommand } from "../lib/setup-e2e.mjs";

import { captureFailure } from "./capture-failure.mjs";

/** What `actana place` prints, in the shape it prints it. */
const placed = (command) =>
  [
    "Installing the Actana Core 0.4.1 for linux-x64.",
    "Checksum verified against the release's SHA256SUMS.",
    "",
    "Core 0.4.1 installed at /home/op/.local/share/actana/versions/0.4.1",
    "  Launcher   /home/op/.local/bin/actana",
    "  Current    /home/op/.local/share/actana/current",
    "",
    "Nothing is running yet: this machine is not a Core until you set it up.",
    "",
    `  ${command}`,
    "",
    "That writes this Core's identity, its auto-start service and its registration.",
  ].join("\n");

describe("nextSetupCommand", () => {
  it("reads back the bare command when the launcher answers to `actana`", () => {
    expect(nextSetupCommand(placed("actana setup"), () => {})).toBe("actana setup");
  });

  // The case a hard-coded `actana setup` in the e2e would hide, and the reason
  // the command is extracted rather than retyped: a fresh machine has no
  // `~/.local/bin` at login, so it is not on `PATH`, so the runnable form is a
  // path.
  it("reads back the absolute path when the launcher's directory is not on PATH", () => {
    const absolute = "/home/op/.local/share/actana/current/bin/actana setup";
    expect(nextSetupCommand(placed(absolute), () => {})).toBe(absolute);
  });

  // `machinectl shell` pipes the container session through a PTY, so what the
  // Linux e2e reads back is CRLF. This is the whole reason the pattern is not
  // anchored on `[ \t]*$`.
  it("reads it back out of PTY output, where every line ends CRLF", () => {
    const pty = placed("actana setup").replace(/\n/g, "\r\n");
    expect(nextSetupCommand(pty, () => {})).toBe("actana setup");
  });

  it("ignores prose that merely mentions the command", () => {
    const noisy = [
      "Run `actana setup` when you are ready — actana setup does the rest.",
      "  /home/op/.local/bin/actana setup",
    ].join("\n");
    expect(nextSetupCommand(noisy, () => {})).toBe("/home/op/.local/bin/actana setup");
  });

  it("fails when the installer stopped saying what to run next", () => {
    const message = captureFailure((fail) =>
      nextSetupCommand("Core 0.4.1 installed at /home/op/.local/share/actana/versions/0.4.1", fail),
    );
    expect(message).toMatch(/exactly one/);
    expect(message).toMatch(/found 0/);
  });

  // Two copies are two things free to disagree — about the launcher's path
  // most of all. The CLI owns the line precisely so there is one.
  it("fails when two commands were printed", () => {
    const twice = ["  actana setup", "  /home/op/.local/bin/actana setup"].join("\n");
    const message = captureFailure((fail) => nextSetupCommand(twice, fail));
    expect(message).toMatch(/exactly one/);
    expect(message).toMatch(/found 2/);
  });
});
