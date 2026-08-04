import { describe, expect, it } from "vitest";
import { harnessPtyEnvOverrides, applyHarnessPtyEnv } from "../harness-pty-env";

describe("applyHarnessPtyEnv", () => {
  it("strips truecolor hints and disables incompatible OpenTUI probes for OpenCode", () => {
    const env = {
      COLORTERM: "truecolor",
      WT_SESSION: "abc",
      TERM: "xterm-256color",
    };
    applyHarnessPtyEnv(env, "opencode");
    expect(env).toEqual({
      TERM: "xterm-256color",
      OPENTUI_FORCE_EXPLICIT_WIDTH: "0",
      OPENTUI_GRAPHICS: "0",
    });
  });

  it("does not override env for other agents", () => {
    const env = { COLORTERM: "truecolor", TERM: "xterm-256color" };
    applyHarnessPtyEnv(env, "claude-code");
    expect(env).toEqual({ COLORTERM: "truecolor", TERM: "xterm-256color" });
  });
});

describe("harnessPtyEnvOverrides", () => {
  it("returns remote-safe OpenCode overrides", () => {
    expect(harnessPtyEnvOverrides("opencode")).toEqual({
      COLORTERM: "",
      OPENTUI_FORCE_EXPLICIT_WIDTH: "0",
      OPENTUI_GRAPHICS: "0",
    });
  });

  it("does not override env for other agents", () => {
    expect(harnessPtyEnvOverrides("claude-code")).toEqual({});
    expect(harnessPtyEnvOverrides(undefined)).toEqual({});
  });
});
