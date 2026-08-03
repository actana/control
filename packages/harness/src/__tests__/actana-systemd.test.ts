import { describe, it, expect } from "vitest";
import {
  parseSystemctlProperties,
  systemdStateFrom,
  systemdStateFromShow,
  parseLingerEnabled,
  renderActanaUnit,
  systemdQuote,
  type ActanaUnitConfig,
} from "../actana-systemd";

const config: ActanaUnitConfig = {
  description: "Actana Control Harness",
  argv: ["/home/op/.local/share/actana/current/bin/actana", "daemon"],
  workingDirectory: "/home/op",
  environment: {
    AC_CORE_LINK_PORT: "8443",
    AC_HARNESS_REMOTE: "1",
    AC_USER_DATA_DIR: "/home/op/.local/share/actana/data",
  },
};

describe("renderActanaUnit", () => {
  it("renders the three sections systemd needs, in order", () => {
    const unit = renderActanaUnit(config);
    expect(unit.indexOf("[Unit]")).toBe(0);
    expect(unit.indexOf("[Service]")).toBeGreaterThan(unit.indexOf("[Unit]"));
    expect(unit.indexOf("[Install]")).toBeGreaterThan(unit.indexOf("[Service]"));
    expect(unit.endsWith("\n")).toBe(true);
  });

  it("starts the daemon through the `current` symlink so an update needs no rewrite", () => {
    expect(renderActanaUnit(config)).toContain(
      `ExecStart="/home/op/.local/share/actana/current/bin/actana" "daemon"`,
    );
  });

  it("installs into default.target — a user unit, never a system one", () => {
    const unit = renderActanaUnit(config);
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("multi-user.target");
    expect(unit).not.toMatch(/^User=/m);
  });

  it("restarts on its own so a crashed daemon does not need an operator", () => {
    const unit = renderActanaUnit(config);
    expect(unit).toContain("Restart=always");
    expect(unit).toMatch(/^RestartSec=\d+$/m);
  });

  it("emits every environment entry quoted and sorted", () => {
    const unit = renderActanaUnit(config);
    const lines = unit.split("\n").filter((l) => l.startsWith("Environment="));
    expect(lines).toEqual([
      `Environment="AC_CORE_LINK_PORT=8443"`,
      `Environment="AC_HARNESS_REMOTE=1"`,
      `Environment="AC_USER_DATA_DIR=/home/op/.local/share/actana/data"`,
    ]);
  });

  it("survives a home directory with spaces, quotes, or backslashes in it", () => {
    const unit = renderActanaUnit({
      ...config,
      argv: [`/home/o p/bin/actana`, "daemon"],
      workingDirectory: `/home/o p`,
      environment: { AC_USER_DATA_DIR: `/home/o "p"\\d` },
    });

    expect(unit).toContain(`ExecStart="/home/o p/bin/actana" "daemon"`);
    expect(unit).toContain(`WorkingDirectory=/home/o p`);
    expect(unit).toContain(`Environment="AC_USER_DATA_DIR=/home/o \\"p\\"\\\\d"`);
  });

  it("tags journal lines so `actana logs` has something to filter on", () => {
    expect(renderActanaUnit(config)).toMatch(/^SyslogIdentifier=\S+$/m);
  });

  it("is byte-identical for identical input, so a re-run is a no-op write", () => {
    expect(renderActanaUnit(config)).toBe(renderActanaUnit({ ...config }));
  });

  it("refuses a relative ExecStart — systemd requires an absolute path", () => {
    expect(() => renderActanaUnit({ ...config, argv: ["bin/actana", "daemon"] })).toThrow(
      /absolute/i,
    );
  });

  it("refuses an environment value containing a newline", () => {
    expect(() =>
      renderActanaUnit({ ...config, environment: { A: "one\ntwo" } }),
    ).toThrow(/newline/i);
  });
});

describe("systemdQuote", () => {
  it("wraps in double quotes and escapes backslashes before quotes", () => {
    expect(systemdQuote(`a"b\\c`)).toBe(`"a\\"b\\\\c"`);
  });
});

describe("parseSystemctlProperties", () => {
  it("parses `systemctl show` KEY=VALUE output", () => {
    const props = parseSystemctlProperties(
      ["LoadState=loaded", "ActiveState=active", "SubState=running", "MainPID=4211"].join("\n"),
    );
    expect(props).toEqual({
      LoadState: "loaded",
      ActiveState: "active",
      SubState: "running",
      MainPID: "4211",
    });
  });

  it("keeps `=` inside a value", () => {
    expect(parseSystemctlProperties("ExecStart={ path=/bin/x ; }")).toEqual({
      ExecStart: "{ path=/bin/x ; }",
    });
  });

  it("keeps an empty value rather than dropping the key", () => {
    expect(parseSystemctlProperties("Result=")).toEqual({ Result: "" });
  });

  it("skips blank and malformed lines instead of throwing", () => {
    expect(parseSystemctlProperties("\nActiveState=active\ngarbage\n\n")).toEqual({
      ActiveState: "active",
    });
  });

  it("returns an empty object for empty output", () => {
    expect(parseSystemctlProperties("")).toEqual({});
  });
});

describe("parseLingerEnabled", () => {
  it("reads `loginctl show-user --property=Linger` output", () => {
    expect(parseLingerEnabled("Linger=yes")).toBe(true);
    expect(parseLingerEnabled("Linger=no")).toBe(false);
  });

  it("finds Linger among other properties", () => {
    expect(parseLingerEnabled("UID=1000\nLinger=yes\nState=active")).toBe(true);
  });

  it("is false when the property is absent — unknown is not enabled", () => {
    expect(parseLingerEnabled("UID=1000")).toBe(false);
    expect(parseLingerEnabled("")).toBe(false);
  });
});

describe("systemdStateFrom", () => {
  it("reads the four properties status cares about", () => {
    expect(
      systemdStateFrom({
        LoadState: "loaded",
        ActiveState: "active",
        SubState: "running",
        MainPID: "4211",
      }),
    ).toEqual({ loadState: "loaded", activeState: "active", subState: "running", mainPid: 4211 });
  });

  it("reports MainPID=0 as no pid — systemd's way of saying nothing is running", () => {
    expect(systemdStateFrom({ ActiveState: "inactive", MainPID: "0" }).mainPid).toBeNull();
  });

  it("falls back to `unknown` for absent properties instead of undefined", () => {
    const state = systemdStateFrom({});
    expect(state.loadState).toBe("unknown");
    expect(state.activeState).toBe("unknown");
    expect(state.subState).toBe("unknown");
    expect(state.mainPid).toBeNull();
  });

  it("is null-pid for a non-numeric MainPID", () => {
    expect(systemdStateFrom({ MainPID: "nope" }).mainPid).toBeNull();
  });
});

describe("systemdStateFromShow", () => {
  it("parses `systemctl show` output straight into a service state", () => {
    expect(
      systemdStateFromShow(
        "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4211\n",
      ),
    ).toEqual({
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      mainPid: 4211,
    });
  });
});
