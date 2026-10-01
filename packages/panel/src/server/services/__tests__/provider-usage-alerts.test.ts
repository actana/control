import { afterEach, describe, expect, it, vi } from "vitest";

// CodeQL alerts 18 and 3 (issue 612): the Copilot host check and the JetBrains
// entity decoder.
const enterpriseHost = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("../provider-usage/credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provider-usage/credentials")>()),
  envFirst: (keys: string[]) => (keys.includes("COPILOT_API_TOKEN") ? "gh-token" : null),
  configEnterpriseHost: () => enterpriseHost.value,
}));

import { decodeXmlAttribute } from "../provider-usage/all-adapters";
import { getProviderUsage, _resetProviderUsageCacheForTests } from "../provider-usage";

async function copilotUrl(host: string | null): Promise<string> {
  enterpriseHost.value = host;
  _resetProviderUsageCacheForTests();
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await getProviderUsage(["copilot"]);
  const calls = fetchMock.mock.calls as unknown as Array<[string]>;
  expect(calls).toHaveLength(1);
  return String(calls[0]?.[0]);
}

describe("Copilot usage URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetProviderUsageCacheForTests();
  });

  it("asks api.github.com when no enterprise host is configured", async () => {
    expect(await copilotUrl(null)).toBe("https://api.github.com/copilot_internal/user");
  });

  it("asks the configured host when its name merely contains api.github.com", async () => {
    expect(await copilotUrl("api.github.com.ghe.example")).toBe(
      "https://api.github.com.ghe.example/copilot_internal/user",
    );
  });
});

describe("decodeXmlAttribute", () => {
  it("decodes &amp; last, so an escaped entity stays text", () => {
    expect(decodeXmlAttribute("&amp;lt;")).toBe("&lt;");
    expect(decodeXmlAttribute("&amp;quot;")).toBe("&quot;");
  });

  it("decodes each entity once", () => {
    expect(decodeXmlAttribute("&quot;a&quot; &lt;b&gt; &apos;c&apos; &amp;")).toBe(`"a" <b> 'c' &`);
  });
});
