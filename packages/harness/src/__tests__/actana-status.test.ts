import { describe, it, expect } from "vitest";
import { formatActanaStatus, summarizeHealth, type ActanaStatusReport } from "../actana-status";

const healthy: ActanaStatusReport = {
  installed: true,
  version: "0.49.0",
  protocolVersion: "3",
  target: "linux-x64",
  endpoint: "wss://10.0.0.5:8443",
  serviceName: "actana-harness.service",
  service: { loadState: "loaded", activeState: "active", subState: "running", mainPid: 4211 },
  persistence: { label: "Linger", value: "yes" },
  paired: true,
  agents: {
    claude: { status: "available", version: "2.1.0" },
    opencode: { status: "missing", reason: "not on PATH" },
  },
};

describe("summarizeHealth", () => {
  it("is healthy when the unit runs and the Core has pairing material", () => {
    expect(summarizeHealth(healthy)).toBe("healthy");
  });

  it("is not-installed before setup has ever run", () => {
    expect(summarizeHealth({ ...healthy, installed: false, service: null })).toBe("not-installed");
  });

  it("is stopped when the unit exists but is not active", () => {
    expect(
      summarizeHealth({
        ...healthy,
        service: { loadState: "loaded", activeState: "inactive", subState: "dead", mainPid: null },
      }),
    ).toBe("stopped");
  });

  it("is degraded when installed but the unit never got written", () => {
    expect(summarizeHealth({ ...healthy, service: null })).toBe("degraded");
  });

  it("is degraded when the unit runs but there is no pairing material", () => {
    expect(summarizeHealth({ ...healthy, paired: false })).toBe("degraded");
  });

  it("is degraded for an active unit that is not actually running the daemon", () => {
    expect(
      summarizeHealth({
        ...healthy,
        service: {
          loadState: "loaded",
          activeState: "activating",
          subState: "auto-restart",
          mainPid: null,
        },
      }),
    ).toBe("degraded");
  });
});

describe("formatActanaStatus", () => {
  it("answers `is my Core healthy?` on the first line", () => {
    expect(formatActanaStatus(healthy).split("\n")[0]).toMatch(/healthy/i);
  });

  it("shows version, protocol version, endpoint, and pid", () => {
    const text = formatActanaStatus(healthy);
    expect(text).toMatch(/0\.49\.0/);
    expect(text).toMatch(/protocol.*\b3\b/i);
    expect(text).toContain("wss://10.0.0.5:8443");
    expect(text).toMatch(/4211/);
  });

  it("lists every agent with its availability", () => {
    const text = formatActanaStatus(healthy);
    expect(text).toMatch(/claude\s+available\s+2\.1\.0/);
    expect(text).toMatch(/opencode\s+missing/);
  });

  it("uses `pairing token`, never `registration blob`, in operator-facing text", () => {
    const text = formatActanaStatus({ ...healthy, paired: false });
    expect(text.toLowerCase()).not.toContain("registration blob");
    expect(text.toLowerCase()).toContain("pairing token");
  });

  it("names the service so an operator knows what to look for on their machine", () => {
    expect(formatActanaStatus(healthy)).toMatch(/Auto-start\s+actana-harness\.service/);
  });

  it("prints whatever persistence row the platform supplied", () => {
    const off = {
      ...healthy,
      persistence: { label: "Linger", value: "no — the daemon stops when you log out" },
    };
    expect(formatActanaStatus(off)).toMatch(/Linger.*\bno\b/i);
    expect(formatActanaStatus(off)).toMatch(/logout|log out/i);
  });

  it("reads as macOS on a Mac — a LaunchAgent, and what that means at logout", () => {
    const mac = {
      ...healthy,
      target: "mac-arm64",
      serviceName: "com.actana.harness",
      persistence: {
        label: "At login",
        value: "yes — starts when you log in, stops when you log out",
      },
    };
    const text = formatActanaStatus(mac);
    expect(text).toMatch(/Auto-start\s+com\.actana\.harness/);
    expect(text).toMatch(/At login\s+yes/);
    expect(text).not.toMatch(/Linger/);
  });

  it("omits the persistence row when the platform could not read it", () => {
    expect(formatActanaStatus({ ...healthy, persistence: null })).not.toMatch(/Linger/);
  });

  it("tells an operator who never ran setup what to run", () => {
    const text = formatActanaStatus({
      installed: false,
      version: null,
      protocolVersion: null,
      target: null,
      endpoint: null,
      serviceName: "actana-harness.service",
      service: null,
      persistence: null,
      paired: false,
      agents: {},
    });
    expect(text).toMatch(/not installed/i);
    expect(text).toContain("actana setup");
  });

  it("renders without an agent probe rather than printing an empty table", () => {
    expect(formatActanaStatus({ ...healthy, agents: {} })).not.toMatch(/^Agents/m);
  });

  it("ends with a newline so shell output does not run together", () => {
    expect(formatActanaStatus(healthy).endsWith("\n")).toBe(true);
  });
});
