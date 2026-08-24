import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { installDirFor, resolveActanaLayout, binDirOnPath } from "../actana-layout";
import { UNIT_NAME } from "../actana-systemd";
import { LAUNCH_AGENT_FILENAME } from "../actana-launchd";

const HOME = "/home/op";
const MAC_HOME = "/Users/op";

describe("resolveActanaLayout", () => {
  it("defaults everything under the operator's home — no sudo path anywhere", () => {
    const l = resolveActanaLayout({}, HOME, "linux");

    expect(l.root).toBe("/home/op/.local/share/actana");
    expect(l.versionsDir).toBe("/home/op/.local/share/actana/versions");
    expect(l.currentLink).toBe("/home/op/.local/share/actana/current");
    expect(l.dataDir).toBe("/home/op/.local/share/actana/data");
    expect(l.configDir).toBe("/home/op/.config/actana");
    expect(l.binDir).toBe("/home/op/.local/bin");
    expect(l.binLink).toBe("/home/op/.local/bin/actana");
    expect(l.serviceDir).toBe("/home/op/.config/systemd/user");
    expect(l.servicePath).toBe(`/home/op/.config/systemd/user/${UNIT_NAME}`);
  });

  it("puts the service where macOS keeps a user's LaunchAgents", () => {
    const l = resolveActanaLayout({}, MAC_HOME, "darwin");

    expect(l.serviceDir).toBe("/Users/op/Library/LaunchAgents");
    expect(l.servicePath).toBe(`/Users/op/Library/LaunchAgents/${LAUNCH_AGENT_FILENAME}`);
  });

  it("keeps the LaunchAgents dir out of XDG's reach — launchd reads nowhere else", () => {
    const l = resolveActanaLayout(
      { XDG_CONFIG_HOME: "/cfg", ACTANA_CONFIG_DIR: "/secrets" },
      MAC_HOME,
      "darwin",
    );

    expect(l.serviceDir).toBe("/Users/op/Library/LaunchAgents");
    expect(l.configDir).toBe("/secrets");
  });

  it("every path is inside the home dir", () => {
    const l = resolveActanaLayout({}, HOME, "linux");
    for (const p of [l.root, l.dataDir, l.configDir, l.binDir, l.serviceDir]) {
      expect(p.startsWith(`${HOME}/`)).toBe(true);
    }
  });

  it("honours XDG_DATA_HOME and XDG_CONFIG_HOME", () => {
    const l = resolveActanaLayout(
      { XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/cfg" },
      HOME,
      "linux",
    );

    expect(l.root).toBe("/data/actana");
    expect(l.dataDir).toBe("/data/actana/data");
    expect(l.configDir).toBe("/cfg/actana");
    // systemd reads user units from $XDG_CONFIG_HOME/systemd/user, not from
    // wherever actana keeps its own config.
    expect(l.serviceDir).toBe("/cfg/systemd/user");
  });

  it("ignores relative XDG values, as the XDG spec requires", () => {
    const l = resolveActanaLayout(
      { XDG_DATA_HOME: "relative/data", XDG_CONFIG_HOME: "" },
      HOME,
      "linux",
    );

    expect(l.root).toBe("/home/op/.local/share/actana");
    expect(l.configDir).toBe("/home/op/.config/actana");
  });

  it("ACTANA_HOME overrides the install root but not the service dir", () => {
    const l = resolveActanaLayout({ ACTANA_HOME: "/opt/actana" }, HOME, "linux");

    expect(l.root).toBe("/opt/actana");
    expect(l.versionsDir).toBe("/opt/actana/versions");
    expect(l.dataDir).toBe("/opt/actana/data");
    expect(l.serviceDir).toBe("/home/op/.config/systemd/user");
  });

  it("ACTANA_CONFIG_DIR and ACTANA_BIN_DIR override their own slots only", () => {
    const l = resolveActanaLayout(
      { ACTANA_CONFIG_DIR: "/secrets", ACTANA_BIN_DIR: "/usr/local/bin" },
      HOME,
      "linux",
    );

    expect(l.configDir).toBe("/secrets");
    expect(l.binLink).toBe("/usr/local/bin/actana");
    expect(l.root).toBe("/home/op/.local/share/actana");
  });

  it("relative overrides resolve against the home dir rather than the CWD", () => {
    const l = resolveActanaLayout({ ACTANA_HOME: "actana-here" }, HOME, "linux");
    expect(l.root).toBe(path.join(HOME, "actana-here"));
  });
});

describe("installDirFor", () => {
  it("gives each version its own directory so an update can swap atomically", () => {
    const l = resolveActanaLayout({}, HOME, "linux");
    expect(installDirFor(l, "0.1.0")).toBe("/home/op/.local/share/actana/versions/0.1.0");
    expect(installDirFor(l, "0.2.0")).toBe("/home/op/.local/share/actana/versions/0.2.0");
  });

  // ADR 0036 D20: a beta and its line are different strings, so they are
  // different directories — an install from a beta tarball cannot land where
  // the release's would, or be reported as it.
  it("gives a beta a directory of its own, beside its line's release", () => {
    const l = resolveActanaLayout({}, HOME, "linux");
    expect(installDirFor(l, "0.4.1-beta")).toBe(
      "/home/op/.local/share/actana/versions/0.4.1-beta",
    );
    expect(installDirFor(l, "0.4.1-beta")).not.toBe(installDirFor(l, "0.4.1"));
  });

  it("refuses a version that would escape the versions dir", () => {
    const l = resolveActanaLayout({}, HOME, "linux");
    expect(() => installDirFor(l, "../../etc")).toThrow(/version/i);
    expect(() => installDirFor(l, "")).toThrow(/version/i);
    expect(() => installDirFor(l, "0.4/9")).toThrow(/version/i);
  });
});

describe("binDirOnPath", () => {
  it("is true when the bin dir is a PATH entry", () => {
    expect(binDirOnPath("/home/op/.local/bin", "/usr/bin:/home/op/.local/bin")).toBe(true);
  });

  it("tolerates a trailing slash on the PATH entry", () => {
    expect(binDirOnPath("/home/op/.local/bin", "/home/op/.local/bin/:/usr/bin")).toBe(true);
  });

  it("is false when absent, and for an empty or missing PATH", () => {
    expect(binDirOnPath("/home/op/.local/bin", "/usr/bin:/bin")).toBe(false);
    expect(binDirOnPath("/home/op/.local/bin", "")).toBe(false);
    expect(binDirOnPath("/home/op/.local/bin", undefined)).toBe(false);
  });

  it("does not match a directory that merely shares a prefix", () => {
    expect(binDirOnPath("/home/op/.local/bin", "/home/op/.local/binx")).toBe(false);
  });
});
