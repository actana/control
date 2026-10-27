// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Sign in and first-boot setup on a phone (#831, M01/M02): a 16 px gutter, a
// full-width card that can be scrolled to with the keyboard up, and a show/hide
// eye on each password field. Desktop keeps today's centred 380 px card and
// plain password inputs.

vi.mock("~/lib/api", () => ({
  api: { login: vi.fn(), setupOperator: vi.fn() },
  ApiError: class extends Error {},
}));

const loginRoute = await import("~/routes/login");
const setupRoute = await import("~/routes/setup");

/** The page component a route file hands the router, ready to render alone. */
function pageOf(route: { options: unknown }): ComponentType {
  const component = (route.options as { component?: ComponentType }).component;
  if (!component) throw new Error("route has no component");
  return component;
}

// jsdom has no matchMedia: report "(max-width: Npx)" queries for a window width.
function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      media: query,
      matches: max ? width <= Number(max[1]) : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

function renderPage(route: { options: unknown }) {
  const Page = pageOf(route);
  render(<Page />);
  const page = document.querySelector<HTMLElement>("[data-auth-page]")!;
  return { page, card: page.querySelector("form")! };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuthCard on a phone", () => {
  it("uses a 16 px gutter, a full-width card and a 100dvh page that is free to scroll", () => {
    stubWidth(390);
    const { page, card } = renderPage(loginRoute.Route);
    expect(page.style.padding).toBe("16px");
    expect(page.style.minHeight).toBe("100dvh");
    // No align-items centring: auto margins centre the card and give way to the
    // top edge when the keyboard shrinks the viewport.
    expect(page.style.alignItems).toBe("");
    expect(page.style.justifyContent).toBe("");
    expect(card.style.maxWidth).toBe("");
    expect(card.style.width).toBe("100%");
    expect(card.style.margin).toBe("auto 0px");
  });

  it("gives the sign-in password a 44 px eye that flips the input type", () => {
    stubWidth(390);
    renderPage(loginRoute.Route);
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    expect(input.type).toBe("password");
    const eye = screen.getByRole("button", { name: "Show password" });
    expect(eye.style.width).toBe("44px");
    expect(eye.style.height).toBe("44px");
    expect(eye.getAttribute("type")).toBe("button");
    fireEvent.click(eye);
    expect(input.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input.type).toBe("password");    // One state signal only: the label flips, there is no aria-pressed as well.
    expect(eye.hasAttribute("aria-pressed")).toBe(false);
  });

  it("gives both setup password fields their own eye, and none to the name", () => {
    stubWidth(390);
    renderPage(setupRoute.Route);
    const eyes = screen.getAllByRole("button", { name: "Show password" });
    expect(eyes).toHaveLength(2);
    fireEvent.click(eyes[1]);
    expect((screen.getByLabelText("Confirm password") as HTMLInputElement).type).toBe("text");
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText("Your name") as HTMLInputElement).type).toBe("text");
  });

  it("keeps the submit button a full-width large button", () => {
    stubWidth(390);
    renderPage(loginRoute.Route);
    expect(screen.getByRole("button", { name: "Sign in" }).className).toContain("mc-btn-lg");
  });
});

describe("AuthCard on desktop keeps today's layout", () => {
  it("centres a 380 px card on a 24 px padded page", () => {
    stubWidth(1280);
    const { page, card } = renderPage(loginRoute.Route);
    expect(page.style.minHeight).toBe("100vh");
    expect(page.style.alignItems).toBe("center");
    expect(page.style.justifyContent).toBe("center");
    expect(page.style.padding).toBe("24px");
    expect(card.style.maxWidth).toBe("380px");
    expect(card.style.margin).toBe("");
    expect(card.style.padding).toBe("28px");
  });

  it("has no eye button and keeps password fields 38 px tall", () => {
    stubWidth(1280);
    renderPage(setupRoute.Route);
    expect(screen.queryByRole("button", { name: /password/i })).toBeNull();
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect((input.parentElement as HTMLElement).style.height).toBe("38px");
  });
});
