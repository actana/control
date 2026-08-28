import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONTAINER_PORT_ENV,
  CONTAINER_PUBLIC_HOST_ENV,
  DEFAULT_CONTAINER_PORT,
  containerRefusal,
  inContainer,
  readContainerContract,
} from "../actana-container";

describe("inContainer", () => {
  it("is on when the image baked ACTANA_CONTAINER=1", () => {
    expect(inContainer({ ACTANA_CONTAINER: "1" })).toBe(true);
  });

  it("is off with no marker at all", () => {
    expect(inContainer({})).toBe(false);
  });

  it("takes only `1` — a stray truthy value is not the image's marker", () => {
    expect(inContainer({ ACTANA_CONTAINER: "true" })).toBe(false);
    expect(inContainer({ ACTANA_CONTAINER: "0" })).toBe(false);
    expect(inContainer({ ACTANA_CONTAINER: "" })).toBe(false);
  });
});

describe("readContainerContract", () => {
  it("takes the public host from the operator and defaults the rest", () => {
    expect(readContainerContract({ ACTANA_PUBLIC_HOST: "core1.example.com" })).toEqual({
      publicHost: "core1.example.com",
      publicHosts: ["core1.example.com"],
      port: DEFAULT_CONTAINER_PORT,
      label: "core1.example.com",
    });
  });

  it("defaults the port to 8443", () => {
    expect(DEFAULT_CONTAINER_PORT).toBe(8443);
  });

  it("reads the port and the label when the operator set them", () => {
    expect(
      readContainerContract({
        ACTANA_PUBLIC_HOST: "10.0.0.5",
        ACTANA_PORT: "9443",
        ACTANA_LABEL: "build box",
      }),
    ).toEqual({
      publicHost: "10.0.0.5",
      publicHosts: ["10.0.0.5"],
      port: 9443,
      label: "build box",
    });
  });

  it("refuses to guess a missing public host, and names the variable", () => {
    const result = readContainerContract({});
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain(CONTAINER_PUBLIC_HOST_ENV);
  });

  it("treats an empty public host as unset rather than as a hostname", () => {
    expect(readContainerContract({ ACTANA_PUBLIC_HOST: "  " })).toHaveProperty("error");
  });

  // ─── Several addresses in one variable (#347) ──────────────────────────
  //
  // A Core reachable on a compose service name and a LAN address at once is
  // the case the single value could not serve. The variable did not change
  // name and a single value did not change meaning; it grew commas.

  it("reads a comma-separated list, first entry the primary", () => {
    expect(readContainerContract({ ACTANA_PUBLIC_HOST: "core,10.0.0.5" })).toEqual({
      publicHost: "core",
      publicHosts: ["core", "10.0.0.5"],
      port: DEFAULT_CONTAINER_PORT,
      // The label still defaults to the address the operator already named —
      // the primary, now that there can be more than one.
      label: "core",
    });
  });

  it("trims the spaces a human writes between the entries", () => {
    expect(readContainerContract({ ACTANA_PUBLIC_HOST: "core, 10.0.0.5" })).toMatchObject({
      publicHosts: ["core", "10.0.0.5"],
    });
  });

  // A doubled or trailing comma is a typo, and reading it as the shorter list
  // it resembles would mint a certificate the operator never asked for.
  it("refuses an empty entry, and names the variable in the refusal", () => {
    for (const value of ["core,,10.0.0.5", "core,", ",core"]) {
      const result = readContainerContract({ ACTANA_PUBLIC_HOST: value });
      expect(result, JSON.stringify(value)).toHaveProperty("error");
      expect((result as { error: string }).error).toContain(CONTAINER_PUBLIC_HOST_ENV);
    }
  });

  it("rejects a port that is not a usable port number", () => {
    for (const port of ["nope", "0", "-1", "65536", "8443.5"]) {
      const result = readContainerContract({ ACTANA_PUBLIC_HOST: "core", ACTANA_PORT: port });
      expect(result, `ACTANA_PORT=${JSON.stringify(port)}`).toHaveProperty("error");
      expect((result as { error: string }).error).toContain(CONTAINER_PORT_ENV);
    }
  });

  it("reads an empty variable as unset, not as an empty value", () => {
    // `ACTANA_PORT=` with nothing after it is what a half-filled compose file
    // looks like; the default is a truer reading of it than an error.
    expect(readContainerContract({ ACTANA_PUBLIC_HOST: "core", ACTANA_PORT: "" })).toMatchObject({
      port: DEFAULT_CONTAINER_PORT,
    });
    expect(readContainerContract({ ACTANA_PUBLIC_HOST: "core", ACTANA_LABEL: "" })).toMatchObject({
      label: "core",
    });
  });

  it("trims surrounding whitespace off the public host", () => {
    expect(readContainerContract({ ACTANA_PUBLIC_HOST: " core1 " })).toMatchObject({
      publicHost: "core1",
    });
  });
});

// A guard, not a unit test: `/.dockerenv` is the obvious thing to reach for
// and the wrong one (ADR 0016 D16). It is absent under Podman and nerdctl, it
// answers "did some runtime start this?" rather than "is this our image?", and
// it is a path anyone can bind-mount into place.
describe("the container marker", () => {
  it("is the only thing this package detects a container by", () => {
    const root = path.resolve(__dirname, "..");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        // Product code only: a test is allowed to name the path it is
        // asserting nobody reads.
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(full);
        } else if (entry.name.endsWith(".ts")) {
          // Comment lines are where `/.dockerenv` is *supposed* to appear —
          // saying why it is not used is the point of that prose.
          const code = fs
            .readFileSync(full, "utf8")
            .split("\n")
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
          if (code.some((line) => line.includes("dockerenv"))) hits.push(full);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

describe("containerRefusal", () => {
  const refused = ["setup", "start", "stop", "restart", "update", "uninstall", "logs"];

  it.each(refused)("refuses `%s` and names the Docker equivalent", (verb) => {
    const message = containerRefusal(verb);
    expect(message).not.toBeNull();
    expect(message).toContain(`actana ${verb}`);
    expect(message).toMatch(/docker/);
  });

  it.each(["status", "token", "harnesses", "daemon"])("leaves `%s` alone", (verb) => {
    expect(containerRefusal(verb)).toBeNull();
  });

  it("points `update` at the pull-and-recreate pair, not at a restart", () => {
    expect(containerRefusal("update")).toMatch(/docker compose pull && docker compose up -d/);
  });

  it("warns that `uninstall`'s volume flag is what destroys the pairing", () => {
    expect(containerRefusal("uninstall")).toMatch(/-v/);
  });
});
