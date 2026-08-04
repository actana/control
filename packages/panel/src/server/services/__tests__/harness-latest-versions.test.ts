import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetHarnessLatestVersionsCacheForTests,
  getHarnessLatestVersions,
} from "../harness-latest-versions";

const fetchMock = vi.fn();

beforeEach(() => {
  _resetHarnessLatestVersionsCacheForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getHarnessLatestVersions", () => {
  it("parses the latest version from the npm registry", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: "2.2.0" }));
    const [result] = await getHarnessLatestVersions(["claude-code"]);
    expect(result).toMatchObject({
      agent: "claude-code",
      supported: true,
      latestVersion: "2.2.0",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
    );
  });

  it("marks Cursor unsupported without touching the network", async () => {
    const [result] = await getHarnessLatestVersions(["cursor-cli"]);
    expect(result).toMatchObject({
      agent: "cursor-cli",
      supported: false,
      latestVersion: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the cached result on subsequent calls", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: "0.140.0" }));
    await getHarnessLatestVersions(["codex"]);
    const [second] = await getHarnessLatestVersions(["codex"]);
    expect(second.latestVersion).toBe("0.140.0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache when refresh is requested", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ version: "1.0.0" }))
      .mockResolvedValueOnce(jsonResponse({ version: "1.1.0" }));
    await getHarnessLatestVersions(["opencode"]);
    const [refreshed] = await getHarnessLatestVersions(["opencode"], { refresh: true });
    expect(refreshed.latestVersion).toBe("1.1.0");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records an error instead of throwing on registry failures", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    const [result] = await getHarnessLatestVersions(["codex"]);
    expect(result).toMatchObject({
      agent: "codex",
      supported: true,
      latestVersion: null,
      error: "unexpected status 500",
    });
  });

  it("records an error when the network is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));
    const [result] = await getHarnessLatestVersions(["claude-code"]);
    expect(result).toMatchObject({
      agent: "claude-code",
      latestVersion: null,
      error: "getaddrinfo ENOTFOUND",
    });
  });
});
