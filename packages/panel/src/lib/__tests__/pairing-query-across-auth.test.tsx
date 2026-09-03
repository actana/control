// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * The pairing query survives the auth round trip (#406).
 *
 * `deploy/docker-compose.yml` prints `…/?step=redeem`, and an operator opening
 * it on a fresh Panel is bounced through `/setup` or `/login` before anything
 * reads it. `FirstRunWizard` picks its starting step out of
 * `window.location.search` once, at mount — so every hop that rebuilds the URL
 * from a bare path silently turns that documented link back into step 1.
 *
 * Both exits from the round trip are covered here, deliberately. Creating the
 * Operator and signing in are different pages with different handlers, the
 * acceptance criterion names both, and fixing either one alone leaves the other
 * broken for exactly the operator the link was written for: the one arriving at
 * a Panel that has never been set up.
 *
 * The assertion is the landing URL *as the wizard reads it* — `?step=redeem`
 * put back through `firstRunStepFromSearch` — rather than a string compare, so
 * this suite fails if the query survives in a shape the wizard cannot parse.
 *
 * It lives beside `~/lib/auth-paths` rather than under `src/routes/`, whose
 * every file the route generator expects to export a `Route`; the two pages are
 * imported by alias, so the folder makes no difference to what is tested. The
 * server half of the same round trip is in
 * `server/__tests__/operator-auth.test.ts`, where the Panel DB harness lives.
 */

class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const api = {
  login: vi.fn(async (_password: string) => ({ ok: true })),
  setupOperator: vi.fn(async (_body: { name: string; password: string }) => ({ ok: true })),
};

vi.mock("~/lib/api", () => ({ api, ApiError }));

const { withCarriedQuery } = await import("~/lib/auth-paths");
const { FIRST_RUN_STEP_IDS, REDEEM_STEP_LINK, firstRunStepFromSearch } = await import(
  "~/shared/core-onboarding"
);
const loginRoute = await import("~/routes/login");
const setupRoute = await import("~/routes/setup");

const REDEEM_STEP = FIRST_RUN_STEP_IDS.indexOf("redeem");

/** The page component a route file hands the router, ready to render alone. */
function pageOf(route: { options: unknown }): ComponentType {
  const component = (route.options as { component?: ComponentType }).component;
  if (!component) throw new Error("route has no component");
  return component;
}

/** Where the last `window.location.assign` was pointed, or null. */
let assigned: string | null = null;
let realLocation: PropertyDescriptor | undefined;

/**
 * Put the browser on `href` with a `location` that records navigations instead
 * of performing them. jsdom's own `assign` is unforgeable and does nothing, so
 * the destination — the whole subject of these tests — is unobservable without
 * standing in for the object.
 */
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

beforeEach(() => {
  assigned = null;
  realLocation = Object.getOwnPropertyDescriptor(window, "location");
});

afterEach(() => {
  cleanup();
  if (realLocation) Object.defineProperty(window, "location", realLocation);
  vi.clearAllMocks();
});

/** Fill a labelled box on the rendered card. */
function type(label: RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function submit(buttonLabel: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: buttonLabel }));
  });
}

async function signIn(): Promise<void> {
  const LoginPage = pageOf(loginRoute.Route);
  render(<LoginPage />);
  type(/^password$/i, "operator-password");
  await submit("Sign in");
}

async function createOperator(): Promise<void> {
  const SetupPage = pageOf(setupRoute.Route);
  render(<SetupPage />);
  type(/your name/i, "Operator");
  type(/^password$/i, "a-long-enough-password");
  type(/confirm password/i, "a-long-enough-password");
  await submit("Create Operator");
}

describe("signing in", () => {
  it("lands the operator back on the step the compose link asked for", async () => {
    browserAt(`/login${REDEEM_STEP_LINK}`);
    await signIn();
    expect(api.login).toHaveBeenCalledOnce();
    expect(assigned).not.toBeNull();
    expect(firstRunStepFromSearch(new URL(assigned!, "http://x").search)).toBe(REDEEM_STEP);
  });

  it("carries the rest of the pairing query, not just the step", async () => {
    browserAt("/login?step=redeem&label=my-panel&session=7f2c1a9e");
    await signIn();
    const search = new URL(assigned!, "http://x").searchParams;
    expect(search.get("step")).toBe("redeem");
    expect(search.get("label")).toBe("my-panel");
    expect(search.get("session")).toBe("7f2c1a9e");
  });

  it("still goes to a bare root when there was nothing to carry", async () => {
    browserAt("/login");
    await signIn();
    expect(assigned).toBe("/");
  });
});

describe("creating the Operator", () => {
  it("lands the operator back on the step the compose link asked for", async () => {
    browserAt(`/setup${REDEEM_STEP_LINK}`);
    await createOperator();
    expect(api.setupOperator).toHaveBeenCalledOnce();
    expect(assigned).not.toBeNull();
    expect(firstRunStepFromSearch(new URL(assigned!, "http://x").search)).toBe(REDEEM_STEP);
  });

  it("carries the rest of the pairing query, not just the step", async () => {
    browserAt("/setup?step=redeem&label=my-panel");
    await createOperator();
    const search = new URL(assigned!, "http://x").searchParams;
    expect(search.get("step")).toBe("redeem");
    expect(search.get("label")).toBe("my-panel");
  });

  it("still goes to a bare root when there was nothing to carry", async () => {
    browserAt("/setup");
    await createOperator();
    expect(assigned).toBe("/");
  });

  it("stays put when the two passwords disagree", async () => {
    browserAt(`/setup${REDEEM_STEP_LINK}`);
    const SetupPage = pageOf(setupRoute.Route);
    render(<SetupPage />);
    type(/your name/i, "Operator");
    type(/^password$/i, "a-long-enough-password");
    type(/confirm password/i, "something-else-entirely");
    await submit("Create Operator");
    expect(api.setupOperator).not.toHaveBeenCalled();
    expect(assigned).toBeNull();
  });
});

describe("withCarriedQuery", () => {
  it("leaves a destination with no query alone", () => {
    expect(withCarriedQuery("/", "")).toBe("/");
    expect(withCarriedQuery("/login", "?")).toBe("/login");
  });

  it("keeps every parameter, in order", () => {
    expect(withCarriedQuery("/login", "?step=redeem&label=my-panel")).toBe(
      "/login?step=redeem&label=my-panel",
    );
  });

  /**
   * The value goes into a `Location` header as well as `location.assign`, so a
   * CR or LF smuggled through the query has to come out escaped rather than
   * splitting the response.
   */
  it("re-encodes a query that would otherwise break a header", () => {
    const carried = withCarriedQuery("/login", "?step=redeem%0d%0aSet-Cookie:%20x=1");
    expect(carried).not.toMatch(/[\r\n]/);
    expect(new URL(carried, "http://x").searchParams.get("step")).toBe(
      "redeem\r\nSet-Cookie: x=1",
    );
  });
});
