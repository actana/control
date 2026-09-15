import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { piAgentDir, piHomeMarkers } from "../pi-agent-dir";

describe("piAgentDir", () => {
  it("defaults to ~/.pi/agent", () => {
    expect(piAgentDir({}, "/home/op")).toBe(path.join("/home/op", ".pi", "agent"));
  });

  it("follows PI_CODING_AGENT_DIR, expanding a leading ~", () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/moved" }, "/home/op")).toBe(
      path.resolve("/home/op", "moved"),
    );
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "/var/pi" }, "/home/op")).toBe(
      path.resolve("/var/pi"),
    );
  });
});

describe("piHomeMarkers (#518 part 3)", () => {
  it("keeps ~/.pi as the default marker", () => {
    expect(piHomeMarkers({}, "/home/op")).toEqual([".pi"]);
    expect(piHomeMarkers({ PI_CODING_AGENT_DIR: "  " }, "/home/op")).toEqual([".pi"]);
  });

  it("uses a home-relative marker when PI_CODING_AGENT_DIR sits under home", () => {
    expect(piHomeMarkers({ PI_CODING_AGENT_DIR: "~/moved/agent" }, "/home/op")).toEqual([
      "moved/agent",
    ]);
    expect(
      piHomeMarkers({ PI_CODING_AGENT_DIR: path.join("/home/op", "cfg", "pi") }, "/home/op"),
    ).toEqual(["cfg/pi"]);
  });

  it("uses an absolute marker when PI_CODING_AGENT_DIR sits outside home", () => {
    expect(piHomeMarkers({ PI_CODING_AGENT_DIR: "/var/pi-agent" }, "/home/op")).toEqual([
      path.resolve("/var/pi-agent"),
    ]);
  });

  it("agrees with the process env when called with defaults", () => {
    // Smoke: the tables call piHomeMarkers() with no args at module load.
    expect(piHomeMarkers()).toEqual(piHomeMarkers(process.env, os.homedir()));
  });
});
