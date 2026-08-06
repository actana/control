import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "actana-update-check-api-"));
process.env.AC_USER_DATA_DIR = tmpRoot;
process.env.AC_PANEL_DATA_DIR = tmpRoot;

const { handleApiRequest } = await import("../api-router");
const { operatorSessionCookie } = await import("./_operator-session");
const { _resetPanelUpdateCheckForTests } = await import("../services/update-check");

const CACHE = path.join(tmpRoot, "update-check.json");

function authedRequest(): Request {
  return new Request("http://localhost/api/update-check", {
    headers: { cookie: operatorSessionCookie() },
  });
}

/** A `releases/latest` answer, or a channel that has nothing to answer with. */
function channel(tag: string | null) {
  return vi.fn(
    async () =>
      new Response(tag === null ? '{"message":"Not Found"}' : JSON.stringify({ tag_name: `v${tag}` }), {
        status: tag === null ? 404 : 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

beforeEach(() => {
  _resetPanelUpdateCheckForTests();
  fs.rmSync(CACHE, { force: true });
  delete process.env.ACTANA_UPDATE_CHECK;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ACTANA_UPDATE_CHECK;
});

describe("GET /api/update-check", () => {
  it("reports the newest release alongside this Panel's own version", async () => {
    vi.stubGlobal("fetch", channel("9.9.9"));

    const response = await handleApiRequest(authedRequest());

    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body).toMatchObject({ latest: "9.9.9", updateAvailable: true });
    expect(typeof body.current).toBe("string");
  });

  it("asks the release channel `install.sh` resolves", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 });
      }),
    );

    await handleApiRequest(authedRequest());

    expect(asked).toEqual(["https://api.github.com/repos/actana/control/releases/latest"]);
  });

  // The live path: nothing is published yet, so `releases/latest` 404s. The
  // endpoint still answers 200 — a Panel with no release channel is not a
  // Panel with a broken API.
  it("answers cleanly when the channel has published nothing", async () => {
    vi.stubGlobal("fetch", channel(null));

    const response = await handleApiRequest(authedRequest());

    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ latest: null, updateAvailable: false });
  });

  it("answers cleanly when the network is gone entirely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      }),
    );

    const response = await handleApiRequest(authedRequest());
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ latest: null, updateAvailable: false });
  });

  it("caches in the data volume rather than asking once per page load", async () => {
    const fetchMock = channel("9.9.9");
    vi.stubGlobal("fetch", fetchMock);

    await handleApiRequest(authedRequest());
    _resetPanelUpdateCheckForTests();
    await handleApiRequest(authedRequest());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(CACHE)).toBe(true);
  });

  it("makes no request when the operator opted out", async () => {
    process.env.ACTANA_UPDATE_CHECK = "0";
    const fetchMock = channel("9.9.9");
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleApiRequest(authedRequest());

    expect(await response!.json()).toMatchObject({ latest: null, updateAvailable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs the Operator's session like every other route", async () => {
    vi.stubGlobal("fetch", channel("9.9.9"));
    const response = await handleApiRequest(new Request("http://localhost/api/update-check"));
    expect(response?.status).toBe(401);
  });
});
