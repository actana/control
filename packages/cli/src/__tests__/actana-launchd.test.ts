import { describe, it, expect } from "vitest";
import {
  chooseLaunchdDomain,
  LAUNCH_AGENT_LABEL,
  launchdLogPath,
  parseLaunchctlPrint,
  plistEscape,
  renderActanaPlist,
  serviceTarget,
  type ActanaPlistConfig,
} from "../actana-launchd";

const config: ActanaPlistConfig = {
  label: LAUNCH_AGENT_LABEL,
  argv: ["/Users/op/.local/share/actana/current/bin/actana", "daemon"],
  workingDirectory: "/Users/op",
  environment: {
    AC_CORE_LINK_PORT: "8443",
    AC_CORE_REMOTE: "1",
    AC_USER_DATA_DIR: "/Users/op/.local/share/actana/data",
  },
  logPath: "/Users/op/Library/Logs/Actana/core.log",
};

describe("renderActanaPlist", () => {
  it("renders a plist launchd will parse", () => {
    const plist = renderActanaPlist(config);
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(plist).toContain("<!DOCTYPE plist PUBLIC");
    expect(plist).toContain('<plist version="1.0">');
    expect(plist.trimEnd().endsWith("</plist>")).toBe(true);
  });

  it("starts the daemon through the `current` symlink so an update needs no rewrite", () => {
    expect(renderActanaPlist(config)).toContain(
      "<string>/Users/op/.local/share/actana/current/bin/actana</string>\n      <string>daemon</string>",
    );
  });

  it("starts at login and comes back on its own when the daemon dies", () => {
    const plist = renderActanaPlist(config);
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
  });

  it("is a LaunchAgent, never a LaunchDaemon — nothing here needs root", () => {
    const plist = renderActanaPlist(config);
    expect(plist).not.toContain("<key>UserName</key>");
    expect(plist).not.toContain("<key>GroupName</key>");
  });

  it("sends both streams to one log file so `actana logs` has one thing to tail", () => {
    const plist = renderActanaPlist(config);
    expect(plist).toContain(
      "<key>StandardErrorPath</key>\n    <string>/Users/op/Library/Logs/Actana/core.log</string>",
    );
    expect(plist).toContain(
      "<key>StandardOutPath</key>\n    <string>/Users/op/Library/Logs/Actana/core.log</string>",
    );
  });

  it("emits every environment entry sorted, so a re-run rewrites nothing", () => {
    const keys = [...renderActanaPlist(config).matchAll(/<key>(AC_[A-Z_]+)<\/key>/g)].map(
      (m) => m[1],
    );
    expect(keys).toEqual(["AC_CORE_LINK_PORT", "AC_CORE_REMOTE", "AC_USER_DATA_DIR"]);
  });

  it("escapes XML metacharacters in paths and values", () => {
    const plist = renderActanaPlist({
      ...config,
      workingDirectory: "/Users/a&b",
      environment: { AC_USER_DATA_DIR: "/Users/<x>/\"d\"" },
    });
    expect(plist).toContain("<string>/Users/a&amp;b</string>");
    expect(plist).toContain("<string>/Users/&lt;x&gt;/&quot;d&quot;</string>");
  });

  it("is byte-identical for identical input, so a re-run is a no-op write", () => {
    expect(renderActanaPlist(config)).toBe(renderActanaPlist({ ...config }));
  });

  it("refuses a relative program path — launchd resolves nothing for you", () => {
    expect(() => renderActanaPlist({ ...config, argv: ["bin/actana", "daemon"] })).toThrow(
      /absolute/i,
    );
  });

  it("refuses an empty argv", () => {
    expect(() => renderActanaPlist({ ...config, argv: [] })).toThrow(/absolute/i);
  });
});

describe("plistEscape", () => {
  it("escapes the three characters that would end a <string>", () => {
    expect(plistEscape(`a<b>c&d"e'f`)).toBe("a&lt;b&gt;c&amp;d&quot;e&apos;f");
  });

  it("escapes ampersands before the entities it introduces", () => {
    expect(plistEscape("&lt;")).toBe("&amp;lt;");
  });
});

describe("parseLaunchctlPrint", () => {
  const RUNNING = `com.actana.core = {
	active count = 1
	path = /Users/op/Library/LaunchAgents/com.actana.core.plist
	state = running

	program = /Users/op/.local/share/actana/current/bin/actana
	pid = 4711
	immediate reason = speculative
}`;

  it("reads the job's state and pid", () => {
    expect(parseLaunchctlPrint(RUNNING)).toEqual({ state: "running", pid: 4711 });
  });

  it("reports a loaded-but-not-running job with no pid", () => {
    expect(
      parseLaunchctlPrint(`com.actana.core = {
	state = waiting
	runs = 3
}`),
    ).toEqual({ state: "waiting", pid: null });
  });

  it("ignores a pid of 0 — launchd's way of saying nothing is running", () => {
    expect(parseLaunchctlPrint("\tstate = waiting\n\tpid = 0\n").pid).toBe(null);
  });

  it("survives output it does not recognise rather than throwing", () => {
    expect(parseLaunchctlPrint("Could not find service")).toEqual({ state: null, pid: null });
  });
});

describe("serviceTarget", () => {
  it("names a job inside its domain", () => {
    expect(serviceTarget("gui/501", "com.actana.core")).toBe("gui/501/com.actana.core");
  });
});

describe("chooseLaunchdDomain", () => {
  it("prefers the GUI domain — where a logged-in Mac's agents live", () => {
    expect(chooseLaunchdDomain(501, () => true)).toBe("gui/501");
  });

  it("falls back to the per-user domain on a machine with no GUI session", () => {
    const probed: string[] = [];
    const domain = chooseLaunchdDomain(501, (candidate) => {
      probed.push(candidate);
      return candidate === "user/501";
    });
    expect(domain).toBe("user/501");
    expect(probed).toEqual(["gui/501", "user/501"]);
  });

  it("still returns the GUI domain when neither probe answers, so the error names it", () => {
    expect(chooseLaunchdDomain(501, () => false)).toBe("gui/501");
  });
});

describe("launchdLogPath", () => {
  it("puts the daemon's output where macOS keeps a user's logs", () => {
    expect(launchdLogPath("/Users/op")).toBe("/Users/op/Library/Logs/Actana/core.log");
  });
});
