import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Both data dirs are per-run temp dirs: the Panel DB (Operator + sessions) and
// the legacy app DB the controllers behind the gate still open on import.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-operator-auth-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const { closePanelDb } = await import("../panel-db");
const { resetRateLimitsForTests } = await import("../services/rate-limits");
const { PANEL_SESSION_COOKIE, documentAuthRedirect } = await import("../panel-auth");

const ORIGIN = "http://panel.example.test";

function request(
  pathname: string,
  init: RequestInit & { cookie?: string; json?: unknown } = {},
): Request {
  const { cookie, json, ...rest } = init;
  const headers: Record<string, string> = {
    ...(rest.headers as Record<string, string> | undefined),
  };
  if (cookie) headers.cookie = cookie;
  if (json !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${pathname}`, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
}

async function call(
  pathname: string,
  init: RequestInit & { cookie?: string; json?: unknown } = {},
): Promise<Response> {
  const response = await handleApiRequest(request(pathname, init));
  if (!response) throw new Error(`no API response for ${pathname}`);
  return response;
}

/** The `name=value` pair from a Set-Cookie header, ready to send back as `cookie`. */
function sessionCookieFrom(response: Response): string {
  const raw = response.headers.getSetCookie().find((c) => c.startsWith(`${PANEL_SESSION_COOKIE}=`));
  if (!raw) throw new Error("no session cookie on response");
  return raw.split(";")[0]!;
}

function setCookieHeader(response: Response): string {
  const raw = response.headers.getSetCookie().find((c) => c.startsWith(`${PANEL_SESSION_COOKIE}=`));
  if (!raw) throw new Error("no session cookie on response");
  return raw;
}

const PASSWORD = "correct-horse-battery";

async function setup(password = PASSWORD): Promise<Response> {
  return call("/api/auth/setup", {
    method: "POST",
    json: { name: "Ada", password },
  });
}

async function login(password = PASSWORD): Promise<Response> {
  return call("/api/auth/login", { method: "POST", json: { password } });
}

/** Fresh Panel data directory — the pre-first-boot state. */
function freshPanelDir(): void {
  closePanelDb();
  const dir = fs.mkdtempSync(path.join(tmpRoot, "panel-"));
  process.env.AC_PANEL_DATA_DIR = dir;
}

beforeEach(() => {
  freshPanelDir();
  // The failed-login bucket is process-global, like the limiter it guards.
  resetRateLimitsForTests();
});

afterAll(() => {
  closePanelDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("first boot", () => {
  it("reports that setup is needed before an Operator exists", async () => {
    const res = await call("/api/auth/state");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needsSetup: true, authenticated: false, operator: null });
  });

  it("creates the Operator and logs the browser in", async () => {
    const res = await setup();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ operator: { name: "Ada" } });

    const state = await call("/api/auth/state", { cookie: sessionCookieFrom(res) });
    expect(await state.json()).toMatchObject({ needsSetup: false, authenticated: true });
  });

  it("allows exactly one Operator", async () => {
    await setup();
    const second = await call("/api/auth/setup", {
      method: "POST",
      json: { name: "Mallory", password: "another-password-x" },
    });
    expect(second.status).toBe(409);
    // The rejected attempt must not have handed out a session.
    expect(second.headers.getSetCookie()).toHaveLength(0);
  });

  it("rejects a password below the minimum length", async () => {
    const res = await call("/api/auth/setup", {
      method: "POST",
      json: { name: "Ada", password: "short" },
    });
    expect(res.status).toBe(400);
    expect(await call("/api/auth/state").then((r) => r.json())).toMatchObject({ needsSetup: true });
  });
});

describe("session cookie", () => {
  it("is HTTP-only, same-site and path-scoped to the whole Panel", async () => {
    const cookie = setCookieHeader(await setup());
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it("is marked Secure when the proxy terminated TLS", async () => {
    await setup();
    const res = await handleApiRequest(
      request("/api/auth/login", {
        method: "POST",
        json: { password: PASSWORD },
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    expect(setCookieHeader(res!)).toMatch(/Secure/i);
  });
});

describe("login", () => {
  it("rejects a wrong password without issuing a cookie", async () => {
    await setup();
    const res = await login("not-the-password");
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("issues a session for the right password", async () => {
    await setup();
    const res = await login();
    expect(res.status).toBe(200);
    const state = await call("/api/auth/state", { cookie: sessionCookieFrom(res) });
    expect(await state.json()).toMatchObject({ authenticated: true });
  });

  it("refuses to log in before setup", async () => {
    const res = await login();
    expect(res.status).toBe(409);
  });

  it("throttles a run of wrong passwords", async () => {
    process.env.AC_LOGIN_RATE_LIMIT_PER_MINUTE = "3";
    try {
      await setup();
      for (let i = 0; i < 3; i++) {
        expect((await login("wrong-password")).status).toBe(401);
      }
      const throttled = await login("wrong-password");
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("retry-after")).toBeTruthy();
      // Throttled requests are refused before the password is verified, so a
      // flood can't make the Panel pay for a scrypt hash per attempt.
      expect((await login()).status).toBe(429);
    } finally {
      delete process.env.AC_LOGIN_RATE_LIMIT_PER_MINUTE;
    }
  });
});

describe("the gate", () => {
  it("rejects an anonymous request to a protected route", async () => {
    await setup();
    const res = await call("/api/projects");
    expect(res.status).toBe(401);
  });

  it("rejects a forged session token", async () => {
    await setup();
    const res = await call("/api/projects", {
      cookie: `${PANEL_SESSION_COOKIE}=not-a-real-session-token`,
    });
    expect(res.status).toBe(401);
  });

  it("lets a logged-in Operator through", async () => {
    const cookie = sessionCookieFrom(await setup());
    const res = await call("/api/projects", { cookie });
    expect(res.status).toBe(200);
  });
});

describe("revocation", () => {
  it("logout invalidates the session it was called with", async () => {
    const cookie = sessionCookieFrom(await setup());
    const out = await call("/api/auth/logout", { method: "POST", cookie });
    expect(out.status).toBe(200);
    // The response clears the browser's cookie…
    expect(setCookieHeader(out)).toMatch(/Max-Age=0/i);
    // …and the token is dead server-side even if the browser keeps sending it.
    expect((await call("/api/projects", { cookie })).status).toBe(401);
  });

  it("a password change invalidates every existing session", async () => {
    const first = sessionCookieFrom(await setup());
    const second = sessionCookieFrom(await login());

    const changed = await call("/api/auth/password", {
      method: "POST",
      cookie: second,
      json: { currentPassword: PASSWORD, newPassword: "a-brand-new-password" },
    });
    expect(changed.status).toBe(200);

    expect((await call("/api/projects", { cookie: first })).status).toBe(401);
    expect((await call("/api/projects", { cookie: second })).status).toBe(401);

    // The caller is handed a fresh session so they aren't logged out of the tab
    // they changed the password in.
    expect((await call("/api/projects", { cookie: sessionCookieFrom(changed) })).status).toBe(200);

    expect((await login(PASSWORD)).status).toBe(401);
    expect((await login("a-brand-new-password")).status).toBe(200);
  });

  it("rejects a password change that gets the current password wrong", async () => {
    const cookie = sessionCookieFrom(await setup());
    const res = await call("/api/auth/password", {
      method: "POST",
      cookie,
      json: { currentPassword: "wrong", newPassword: "a-brand-new-password" },
    });
    expect(res.status).toBe(401);
    // The session that made the failed attempt still works.
    expect((await call("/api/projects", { cookie })).status).toBe(200);
  });

  it("requires a session to change the password", async () => {
    await setup();
    const res = await call("/api/auth/password", {
      method: "POST",
      json: { currentPassword: PASSWORD, newPassword: "a-brand-new-password" },
    });
    expect(res.status).toBe(401);
  });
});

describe("the served UI", () => {
  function navigate(pathname: string, cookie?: string): Request {
    return request(pathname, { headers: { accept: "text/html" }, cookie });
  }

  it("sends a browser to setup while no Operator exists", () => {
    const res = documentAuthRedirect(navigate("/"));
    expect(res?.status).toBe(303);
    expect(res?.headers.get("location")).toBe("/setup");
  });

  it("sends an anonymous browser to login once setup is done", async () => {
    await setup();
    expect(documentAuthRedirect(navigate("/"))?.headers.get("location")).toBe("/login");
    expect(documentAuthRedirect(navigate("/projects/abc"))?.headers.get("location")).toBe(
      "/login",
    );
    // Setup is closed now — it must not be reachable a second time.
    expect(documentAuthRedirect(navigate("/setup"))?.headers.get("location")).toBe("/login");
  });

  it("serves the login page itself anonymously", async () => {
    await setup();
    expect(documentAuthRedirect(navigate("/login"))).toBeNull();
  });

  it("lets a signed-in Operator through, and past login", async () => {
    const cookie = sessionCookieFrom(await setup());
    expect(documentAuthRedirect(navigate("/", cookie))).toBeNull();
    expect(documentAuthRedirect(navigate("/login", cookie))?.headers.get("location")).toBe("/");
  });

  it("leaves asset and module requests alone", async () => {
    await setup();
    // The login page has to be able to load its own JavaScript.
    expect(documentAuthRedirect(request("/assets/index.js"))).toBeNull();
  });

  /**
   * The gate is the first thing the documented Compose link meets, and for a
   * long time it was where the link died: `?step=redeem` went in and a bare
   * `/setup` came out, so the wizard opened on step 1 having been asked for
   * step 3 (#406). Every hop is checked, because a browser on a fresh Panel
   * makes two of them before a page renders.
   */
  describe("the pairing query", () => {
    const REDEEM = "?step=redeem";

    it("rides out to setup on first boot", () => {
      expect(documentAuthRedirect(navigate(`/${REDEEM}`))?.headers.get("location")).toBe(
        `/setup${REDEEM}`,
      );
    });

    it("rides out to login once an Operator exists", async () => {
      await setup();
      expect(documentAuthRedirect(navigate(`/${REDEEM}`))?.headers.get("location")).toBe(
        `/login${REDEEM}`,
      );
      // And on the hop that closes setup behind the first Operator.
      expect(documentAuthRedirect(navigate(`/setup${REDEEM}`))?.headers.get("location")).toBe(
        `/login${REDEEM}`,
      );
    });

    it("rides home again for a browser that is already signed in", async () => {
      const cookie = sessionCookieFrom(await setup());
      expect(
        documentAuthRedirect(navigate(`/login${REDEEM}`, cookie))?.headers.get("location"),
      ).toBe(`/${REDEEM}`);
      expect(
        documentAuthRedirect(navigate(`/setup${REDEEM}`, cookie))?.headers.get("location"),
      ).toBe(`/${REDEEM}`);
    });

    it("keeps the rest of the query with it", async () => {
      await setup();
      expect(
        documentAuthRedirect(navigate("/?step=redeem&label=my-panel"))?.headers.get("location"),
      ).toBe("/login?step=redeem&label=my-panel");
    });

    /**
     * The carried value reaches a response header, so it is re-encoded rather
     * than pasted through: a CR or LF in the query must not be able to end the
     * `Location` line and start one of its own.
     */
    it("cannot smuggle a second header out of the query", async () => {
      await setup();
      const location = documentAuthRedirect(
        navigate("/?step=redeem%0d%0aSet-Cookie:%20stolen=1"),
      )?.headers.get("location");
      expect(location).not.toMatch(/[\r\n]/);
      expect(location).toBe("/login?step=redeem%0D%0ASet-Cookie%3A+stolen%3D1");
    });
  });
});

describe("restart", () => {
  it("keeps the Operator and live sessions across a process restart", async () => {
    const cookie = sessionCookieFrom(await setup());

    // Closing and reopening the Panel DB from the same data directory is what a
    // restart looks like to everything above the storage layer.
    closePanelDb();

    expect(await call("/api/auth/state").then((r) => r.json())).toMatchObject({
      needsSetup: false,
    });
    expect((await call("/api/projects", { cookie })).status).toBe(200);
  });
});
