// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The third leg of the auth round trip: a session that dies under an open tab.
 *
 * `documentAuthRedirect` never sees it — the browser is already on the page and
 * the next `/api/*` call comes back 401 — so `redirectToLoginOnce` is the only
 * thing that decides where that operator lands, and it was the one behaviour
 * changed by #406 with nothing exercising it (#490 review N1).
 *
 * It has its own file because `pairing-query-across-auth.test.tsx` mocks
 * `~/lib/api` wholesale; this suite needs the real module and a stubbed
 * `fetch` under it.
 */

/** Where the last `window.location.assign` was pointed, or null. */
let assigned: string | null = null;
let realLocation: PropertyDescriptor | undefined;

function browserAt(href: string): void {
  const url = new URL(href, "http://panel.example.test");
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      assign: (target: string) => {
        assigned = target;
      },
    },
  });
}

/** Answer every call with one status, so `req` takes the branch under test. */
function respondWith(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status })),
  );
}

const { api, ApiError } = await import("~/lib/api");

/** Drive one gated call and swallow the `ApiError` the failure raises. */
async function callTheApi(): Promise<void> {
  await expect(api.listCores()).rejects.toBeInstanceOf(ApiError);
}

beforeEach(() => {
  assigned = null;
  realLocation = Object.getOwnPropertyDescriptor(window, "location");
});

afterEach(() => {
  if (realLocation) Object.defineProperty(window, "location", realLocation);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("a 401 under an open tab", () => {
  it("brings the operator back to the step they were on", async () => {
    respondWith(401);
    browserAt("/?step=redeem");
    await callTheApi();
    expect(assigned).toBe("/login?step=redeem");
  });

  it("goes to a bare login page when there was nothing to carry", async () => {
    respondWith(401);
    browserAt("/");
    await callTheApi();
    expect(assigned).toBe("/login");
  });

  /**
   * The same narrowing the gate and the two pages apply (#490 review B1): the
   * expiry happens on `/projects/$id`, the operator is sent to `/login`, and
   * `coreId` means nothing there or on the `/` they sign in to.
   */
  it("leaves a deep route's own parameters behind", async () => {
    respondWith(401);
    browserAt("/projects/p1?coreId=core-b");
    await callTheApi();
    expect(assigned).toBe("/login");
  });

  it("stays put when the 401 arrives on the login page itself", async () => {
    respondWith(401);
    browserAt("/login?step=redeem");
    await callTheApi();
    expect(assigned).toBeNull();
  });

  it("does not redirect on any other failure", async () => {
    respondWith(500);
    browserAt("/?step=redeem");
    await callTheApi();
    expect(assigned).toBeNull();
  });
});
