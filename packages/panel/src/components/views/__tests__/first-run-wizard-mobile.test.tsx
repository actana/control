// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// The first-run wizard and its pairing form on a phone (#831, M03–M05): commands
// wrap beside a 44 px copy button, the Compose bar stacks, the step rail scrolls
// sideways onto the active step, and the footer is two equal large buttons.
// Desktop keeps today's layout, asserted alongside.

const PRESENTED =
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

const api = vi.hoisted(() => ({
  inspectCoreForPairing: vi.fn(async (_address: string) => ({
    identity: {
      fingerprint:
        "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
      httpsOrigin: "https://prod-vm-1.internal:7777",
    },
  })),
  pairCore: vi.fn(),
  // The form looks for a half-paired Core to resume on mount.
  listCores: vi.fn(async () => ({ cores: [] })),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { FirstRunWizard } = await import("../FirstRunWizard");

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

const renderWizard = () => render(<FirstRunWizard onPaired={async () => undefined} />);

function commandLines(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-command-line]")];
}

function copyButtons(): HTMLElement[] {
  return screen.getAllByRole("button", { name: /^Copy:/ });
}

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

async function verifyFingerprint(): Promise<void> {
  fireEvent.change(screen.getByLabelText("Core address"), { target: { value: "prod-vm-1.internal:7777" } });
  await click("Check fingerprint");
  await act(async () => {
    fireEvent.change(screen.getByLabelText("CA fingerprint from `actana pair new`"), {
      target: { value: PRESENTED },
    });
  });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("FirstRunWizard on a phone", () => {
  beforeEach(() => stubWidth(390));

  it("pads the page 16 px with a 24 px top", () => {
    renderWizard();
    const page = document.querySelector<HTMLElement>("[data-first-run-wizard] > div");
    expect(page?.style.padding).toBe("24px 16px 32px");
  });

  it("wraps commands instead of scrolling them, beside a 44 px copy button", () => {
    renderWizard();
    expect(commandLines().length).toBeGreaterThan(0);
    for (const line of commandLines()) {
      const code = line.querySelector("code")!;
      expect(code.style.whiteSpace).toBe("pre-wrap");
      expect(code.style.overflowWrap).toBe("anywhere");
      expect(code.style.overflowX).toBe("");
    }
    for (const button of copyButtons()) expect(button.style.minHeight).toBe("44px");
  });

  it("stacks the Compose bar: text, then the jump button, then the command", () => {
    renderWizard();
    const bar = document.querySelector<HTMLElement>("[data-compose-shortcut]")!;
    const row = bar.firstElementChild as HTMLElement;
    expect(row.style.flexDirection).toBe("column");
    expect(row.children[1].tagName).toBe("BUTTON");
    expect(row.children[1].className).toContain("mc-btn-md");
    expect(bar.lastElementChild?.hasAttribute("data-command-line")).toBe(true);
  });

  it("turns the step rail into a horizontal scroller of 216 px cards", () => {
    renderWizard();
    const rail = document.querySelector<HTMLElement>("[data-step-rail]")!;
    expect(rail.style.overflowX).toBe("auto");
    for (const li of rail.querySelectorAll<HTMLElement>("li")) expect(li.style.flex).toBe("0 0 216px");
  });

  it("scrolls the active step into view when the step changes", async () => {
    const scrolled: Element[] = [];
    const spy = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: spy, configurable: true, writable: true });
    renderWizard();
    await click("Next");
    expect(spy).toHaveBeenLastCalledWith({ inline: "center", block: "nearest" });
    expect(scrolled.at(-1)?.getAttribute("aria-current")).toBe("step");
    expect(scrolled.at(-1)?.textContent).toMatch(/Step 2/);
  });

  it("does not throw where scrollIntoView does not exist (jsdom)", () => {
    expect(() => renderWizard()).not.toThrow();
  });

  it("makes Back and Next two equal large buttons", () => {
    renderWizard();
    const back = screen.getByRole("button", { name: "Back" });
    const next = screen.getByRole("button", { name: "Next" });
    for (const button of [back, next]) {
      expect(button.className).toContain("mc-btn-lg");
      expect(button.style.flex).toBe("1 1 0%");
      expect(button.style.minHeight).toBe("44px");
    }
  });

  it("on step 3, Back is alone and full width with the closing line below it", async () => {
    renderWizard();
    await click(/Step 3/);
    const footer = document.querySelector<HTMLElement>("[data-wizard-footer]")!;
    const back = screen.getByRole("button", { name: "Back" });
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(back.style.flex).toBe("1 1 0%");
    expect(footer.lastElementChild?.textContent).toBe("The Panel opens as soon as a Core pairs.");
  });

  it("stacks the pairing address row with a full-width 44 px Check fingerprint", async () => {
    renderWizard();
    await click(/Step 3/);
    const row = document.querySelector<HTMLElement>("[data-address-row]")!;
    expect(row.style.flexDirection).toBe("column");
    const check = screen.getByRole("button", { name: "Check fingerprint" });
    expect(check.style.width).toBe("100%");
    expect(check.style.minHeight).toBe("44px");
  });

  it("wraps the presented fingerprint and gives Pair Core the full width", async () => {
    renderWizard();
    await click(/Step 3/);
    await verifyFingerprint();
    const value = screen.getAllByText(PRESENTED)[0];
    expect(value.style.overflowWrap).toBe("anywhere");
    expect(value.style.wordBreak).toBe("break-all");
    const pair = screen.getByRole("button", { name: "Pair Core" });
    expect(pair.style.width).toBe("100%");
    expect(pair.style.minHeight).toBe("44px");
    expect(pair.className).toContain("mc-btn-lg");
  });
});

describe("FirstRunWizard on desktop keeps today's layout", () => {
  beforeEach(() => stubWidth(1280));

  it("keeps the page padding, nowrap commands and small copy buttons", () => {
    renderWizard();
    const page = document.querySelector<HTMLElement>("[data-first-run-wizard] > div");
    expect(page?.style.padding).toBe("48px 24px 64px");
    for (const line of commandLines()) {
      const code = line.querySelector("code")!;
      expect(code.style.whiteSpace).toBe("pre");
      expect(code.style.overflowX).toBe("auto");
    }
    for (const button of copyButtons()) {
      expect(button.style.minHeight).toBe("");
      expect(button.style.padding).toBe("3px 7px");
    }
  });

  it("keeps the Compose bar in a row and the rail as equal flex cards", () => {
    renderWizard();
    const row = document.querySelector<HTMLElement>("[data-compose-shortcut]")!.firstElementChild as HTMLElement;
    expect(row.style.flexDirection).toBe("");
    expect(row.style.flexWrap).toBe("wrap");
    const rail = document.querySelector<HTMLElement>("[data-step-rail]")!;
    expect(rail.style.overflowX).toBe("");
    for (const li of rail.querySelectorAll<HTMLElement>("li")) expect(li.style.flex).toBe("1 1 0%");
  });

  it("keeps small Back / Next at either end and the closing line beside Back", async () => {
    renderWizard();
    expect(screen.getByRole("button", { name: "Back" }).className).toContain("mc-btn-sm");
    expect(screen.getByRole("button", { name: "Next" }).className).toContain("mc-btn-sm");
    expect(document.querySelector("[data-wizard-footer]")).toBeNull();
    await click(/Step 3/);
    const back = screen.getByRole("button", { name: "Back" });
    expect(back.nextElementSibling?.textContent).toBe("The Panel opens as soon as a Core pairs.");
  });

  it("keeps the address row inline and Pair Core small with its icon", async () => {
    renderWizard();
    await click(/Step 3/);
    const row = document.querySelector<HTMLElement>("[data-address-row]")!;
    expect(row.style.flexDirection).toBe("");
    expect(row.style.alignItems).toBe("flex-end");
    expect(screen.getByRole("button", { name: "Check fingerprint" }).getAttribute("style")).toBeNull();
    await verifyFingerprint();
    const pair = screen.getByRole("button", { name: "Pair Core" });
    expect(pair.className).toContain("mc-btn-sm");
    expect(pair.getAttribute("style")).toBeNull();
    expect(pair.querySelector("svg")).not.toBeNull();
  });
});
