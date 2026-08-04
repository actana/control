import { describe, it, expect } from "vitest";
import {
  buildMissionControlApiUrl,
  buildLocalMissionControlApiUrl,
  buildHarnessLocalHookApiUrl,
  buildSyntheticHookUrl,
  hookEndpointSlug,
  LOCAL_HOOK_API_HOST,
} from "../mission-control-hook-env";

describe("buildMissionControlApiUrl — host parameterization", () => {
  it("builds a loopback URL for the host machine", () => {
    expect(buildMissionControlApiUrl(LOCAL_HOOK_API_HOST, 8080)).toBe("http://127.0.0.1:8080");
  });

  it("rejects hosts outside the allow-list", () => {
    expect(buildMissionControlApiUrl("evil.example.com", 9333)).toBeNull();
    expect(buildMissionControlApiUrl("10.0.0.1", 9333)).toBeNull();
    expect(buildMissionControlApiUrl("host.docker.internal", 9333)).toBeNull();
  });

  it("rejects invalid ports", () => {
    expect(buildMissionControlApiUrl(LOCAL_HOOK_API_HOST, 0)).toBeNull();
    expect(buildMissionControlApiUrl(LOCAL_HOOK_API_HOST, -1)).toBeNull();
    expect(buildMissionControlApiUrl(LOCAL_HOOK_API_HOST, 70000)).toBeNull();
    expect(buildMissionControlApiUrl(LOCAL_HOOK_API_HOST, 1.5)).toBeNull();
    expect(buildMissionControlApiUrl(LOCAL_HOOK_API_HOST, null)).toBeNull();
    expect(buildMissionControlApiUrl(LOCAL_HOOK_API_HOST, undefined)).toBeNull();
  });
});

describe("host-specific convenience builders", () => {
  it("buildLocalMissionControlApiUrl targets loopback", () => {
    expect(buildLocalMissionControlApiUrl(8080)).toBe("http://127.0.0.1:8080");
    expect(buildLocalMissionControlApiUrl(0)).toBeNull();
  });

  it("buildHarnessLocalHookApiUrl targets loopback agent HTTP", () => {
    expect(buildHarnessLocalHookApiUrl(9333)).toBe("http://127.0.0.1:9333");
  });
});

describe("buildSyntheticHookUrl", () => {
  it("accepts a loopback base", () => {
    const url = buildSyntheticHookUrl(
      { apiUrl: "http://127.0.0.1:8080", token: "t" },
      "claude-code",
      "task-1",
    );
    expect(url).toBe("http://127.0.0.1:8080/api/hooks/claude?taskId=task-1");
  });

  it("rejects non-http, port-less, and off-allow-list hosts", () => {
    expect(
      buildSyntheticHookUrl({ apiUrl: "https://127.0.0.1:8080", token: "t" }, "claude-code", "x"),
    ).toBeNull();
    expect(
      buildSyntheticHookUrl({ apiUrl: "http://127.0.0.1", token: "t" }, "claude-code", "x"),
    ).toBeNull();
    expect(
      buildSyntheticHookUrl({ apiUrl: "http://evil.example.com:9333", token: "t" }, "claude-code", "x"),
    ).toBeNull();
    expect(buildSyntheticHookUrl({ apiUrl: "not a url", token: "t" }, "claude-code", "x")).toBeNull();
  });
});

describe("hookEndpointSlug", () => {
  it("maps agents to their hook endpoint slug", () => {
    expect(hookEndpointSlug("codex")).toBe("codex");
    expect(hookEndpointSlug("cursor-cli")).toBe("cursor");
    expect(hookEndpointSlug("opencode")).toBe("opencode");
    expect(hookEndpointSlug("claude-code")).toBe("claude");
    expect(hookEndpointSlug(undefined)).toBe("claude");
  });
});
