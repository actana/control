import { describe, it, expect } from "vitest";
import { formatActanaStatus, summarizeHealth, type ActanaStatusReport } from "../actana-status";

const healthy: ActanaStatusReport = {
  installed: true,
  version: "0.1.0",
  // The ordinary case: the CLI shipped with the Core it manages, so there is
  // one version and the report says it once.
  cliVersion: "0.1.0",
  protocolVersion: "3",
  target: "linux-x64",
  endpoint: "wss://10.0.0.5:8443",
  serviceName: "actana-core.service",
  service: { loadState: "loaded", activeState: "active", subState: "running", mainPid: 4211 },
  persistence: { label: "Linger", value: "yes" },
  container: null,
  paired: true,
  agents: {
    claude: { status: "available", version: "2.1.0" },
    opencode: { status: "missing", reason: "not on PATH" },
  },
  update: null,
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
    expect(text).toMatch(/0\.1\.0/);
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
    expect(formatActanaStatus(healthy)).toMatch(/Auto-start\s+actana-core\.service/);
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
      serviceName: "com.actana.core",
      persistence: {
        label: "At login",
        value: "yes — starts when you log in, stops when you log out",
      },
    };
    const text = formatActanaStatus(mac);
    expect(text).toMatch(/Auto-start\s+com\.actana\.core/);
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
      cliVersion: "0.1.0",
      protocolVersion: null,
      target: null,
      endpoint: null,
      serviceName: "actana-core.service",
      service: null,
      persistence: null,
      container: null,
      paired: false,
      agents: {},
      update: null,
    });
    expect(text).toMatch(/not installed/i);
    expect(text).toContain("actana setup");
  });

  it("renders without an agent probe rather than printing an empty table", () => {
    expect(formatActanaStatus({ ...healthy, agents: {} })).not.toMatch(/^Harnesses/m);
  });

  it("ends with a newline so shell output does not run together", () => {
    expect(formatActanaStatus(healthy).endsWith("\n")).toBe(true);
  });
});

// An alert, and only an alert: the line names the command and never runs it,
// and nothing about it reaches the exit code a script reads.
describe("the update availability line", () => {
  const available = {
    ...healthy,
    update: { current: "0.1.0", latest: "0.2.0", updateAvailable: true },
  };

  it("names the newer release and the version this Core is on", () => {
    const text = formatActanaStatus(available);
    expect(text).toMatch(/Update\s+0\.2\.0 is available — you're on 0\.1\.0/);
  });

  it("tells a metal install to run `actana update`", () => {
    expect(formatActanaStatus(available)).toMatch(/run: actana update$/m);
  });

  it("tells a container operator to pull the image on the host instead", () => {
    const text = formatActanaStatus({
      ...available,
      serviceName: null,
      service: null,
      persistence: null,
      container: { listening: true, port: 8443 },
    });
    expect(text).toContain("run: docker compose pull && docker compose up -d");
    expect(text).not.toMatch(/run: actana update/);
  });

  // No button, no prompt, no offer — the remedy is a sentence the operator
  // types (ADR 0010).
  it("offers nothing to press", () => {
    expect(formatActanaStatus(available)).not.toMatch(/\[y\/n\]|press|install now/i);
  });

  it("says nothing when this Core is already on the newest release", () => {
    const text = formatActanaStatus({
      ...healthy,
      update: { current: "0.2.0", latest: "0.2.0", updateAvailable: false },
    });
    expect(text).not.toMatch(/Update/);
  });

  // The live path today: the repository has published no releases, so the
  // check has nothing to report and status looks exactly as it did before.
  it("says nothing when the channel could not be read", () => {
    const text = formatActanaStatus({
      ...healthy,
      update: { current: "0.1.0", latest: null, updateAvailable: false },
    });
    expect(text).toBe(formatActanaStatus(healthy));
  });

  it("does not make an out-of-date Core unhealthy", () => {
    expect(summarizeHealth(available)).toBe("healthy");
  });
});

// In the image there is no unit and no linger — the thing that restarts this
// Core is the container's restart policy, which lives on the host (ADR 0016
// D16). Status says so rather than naming a unit that does not exist.
describe("in a container", () => {
  const inContainer: ActanaStatusReport = {
    ...healthy,
    serviceName: null,
    service: null,
    persistence: null,
    container: { listening: true, port: 8443 },
  };

  it("is healthy when the daemon answers and the Core is paired", () => {
    expect(summarizeHealth(inContainer)).toBe("healthy");
  });

  it("is stopped when nothing answers on the core-link port", () => {
    expect(summarizeHealth({ ...inContainer, container: { listening: false, port: 8443 } })).toBe(
      "stopped",
    );
  });

  it("is degraded when the daemon answers but has minted no material yet", () => {
    expect(summarizeHealth({ ...inContainer, paired: false })).toBe("degraded");
  });

  it("reports the restart policy as the auto-start row, not a unit file", () => {
    const text = formatActanaStatus(inContainer);
    expect(text).toMatch(/Auto-start\s+.*restart policy/i);
    expect(text).not.toMatch(/actana-core\.service|systemd|Linger/i);
  });

  it("points the operator at where the restart policy actually lives", () => {
    expect(formatActanaStatus(inContainer)).toMatch(/docker inspect/);
  });

  it("reports the daemon's state as whether its port answers", () => {
    expect(formatActanaStatus(inContainer)).toMatch(/State\s+running/);
    expect(
      formatActanaStatus({ ...inContainer, container: { listening: false, port: 9443 } }),
    ).toMatch(/State\s+not running.*9443/);
  });
});

describe("version skew is tolerated and reported (#288 D10)", () => {
  // One binary now manages an install it did not necessarily ship with: a CLI
  // from `npm i -g @actana/cli` can be a train ahead of, or behind, the Core it
  // is standing on. That is a fact to print, not a condition to refuse on.
  const skewed: ActanaStatusReport = { ...healthy, version: "0.3.3", cliVersion: "0.4.0" };

  it("prints both versions and says which is which", () => {
    const text = formatActanaStatus(skewed);
    expect(text).toMatch(/Version\s+0\.3\.3/);
    expect(text).toMatch(/CLI version\s+0\.4\.0/);
  });

  it("still reports the Core as healthy — a version difference is not a fault", () => {
    // The half that matters more than the row. `actana status` is documented as
    // a health check and exits non-zero when the Core is unhealthy; a machine
    // whose operator ran `npm update` must not start failing deployments.
    expect(summarizeHealth(skewed)).toBe("healthy");
  });

  it("says nothing when the two agree", () => {
    // A row that appeared on every machine would be noise, and would train an
    // operator to ignore it on the one machine where it means something.
    expect(formatActanaStatus(healthy)).not.toMatch(/CLI version/);
  });

  it("reports the install's version, never the CLI's, as the Core's", () => {
    // The local verbs read the install's own manifest so they act on what is
    // actually there. A `Version` row that echoed the CLI would be this program
    // reporting on itself and calling it the Core.
    expect(formatActanaStatus(skewed)).not.toMatch(/Version\s+0\.4\.0/);
  });
});
