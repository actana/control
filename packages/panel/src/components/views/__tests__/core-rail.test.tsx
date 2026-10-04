// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CoreWithDial } from "~/shared/cores";

// The rail lists Cores and nothing else: initials, status dots, hotkeys 1 to 9.
// It runs inside a REAL router, because the active ring and the tile links are
// route behaviour a stub would answer for the component.

let cores: CoreWithDial[] = [];
let rows: { coreId: string; status: string }[] = [];
let coresLoading = false;

vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores, coresLoading, fleet: { rows, offlineCores: [], singleCore: false } }),
}));
vi.mock("~/lib/keybindings/store", () => ({
  useBinding: () => ({ mod: true, shift: false, alt: false, key: "1" }),
}));

const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } =
  await import("@tanstack/react-router");
const { CoreRail } = await import("../CoreRail");
const { useCoreHotkeys } = await import("~/lib/use-core-hotkeys");

function core(id: string, label: string, state: CoreWithDial["dial"]["state"] = "connected"): CoreWithDial {
  return {
    id,
    endpoint: "wss://x",
    label,
    lastEventId: 0,
    createdAt: 0,
    updatedAt: 0,
    dial: { coreId: id, state, lastSeenAt: 1 },
  };
}

const opened: string[] = [];

function Harness() {
  useCoreHotkeys(cores, (id) => opened.push(id));
  return (
    <>
      <CoreRail />
      <Outlet />
    </>
  );
}

async function mount(path = "/") {
  const root = createRootRoute({ component: Harness });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const coreRoute = createRoute({
    getParentRoute: () => root,
    path: "/cores/$coreId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([index, coreRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  return router;
}

afterEach(() => {
  cleanup();
  opened.length = 0;
  rows = [];
});

describe("CoreRail", () => {
  it("lists one tile per Core, with initials and hotkey digits, and no project controls", async () => {
    cores = [core("c2", "build-box-01"), core("c1", "workstation-berlin")];
    await mount();
    const tiles = document.querySelectorAll("[data-core-tile]");
    expect([...tiles].map((t) => t.getAttribute("data-core-tile"))).toEqual(["c2", "c1"]);
    expect(tiles[0]!.textContent).toContain("BB");
    expect(tiles[0]!.querySelector("[data-core-hotkey]")?.textContent).toBe("1");
    expect(tiles[1]!.querySelector("[data-core-hotkey]")?.textContent).toBe("2");
    expect(screen.queryByText(/add project/i)).toBeNull();
    expect(screen.getByText("2 Cores")).toBeTruthy();
  });

  it("does not claim 0 Cores while the Core list is still loading", async () => {
    cores = [];
    coresLoading = true;
    try {
      await mount();
      expect(screen.queryByText("0 Cores")).toBeNull();
    } finally {
      coresLoading = false;
    }
  });

  it("gives hotkey digits to the first nine Cores only", async () => {
    cores = Array.from({ length: 11 }, (_, i) => core(`c${i}`, `core-${String(i).padStart(2, "0")}`));
    await mount();
    expect(document.querySelectorAll("[data-core-hotkey]").length).toBe(9);
    expect(document.querySelectorAll("[data-core-tile]").length).toBe(11);
  });

  it("shows a running dot per running Session, an attention badge for needs-input, and an offline dot", async () => {
    cores = [core("a", "alpha"), core("b", "bravo", "unreachable")];
    rows = [
      { coreId: "a", status: "running" },
      { coreId: "a", status: "running" },
      { coreId: "a", status: "needs-input" },
    ];
    await mount();
    const alpha = document.querySelector('[data-core-tile="a"]')!;
    expect(alpha.querySelectorAll('[data-core-dot="running"]').length).toBe(2);
    expect(alpha.querySelectorAll('[data-core-dot="needs-input"]').length).toBe(1);
    expect(alpha.querySelector('[aria-label="Needs input"]')).toBeTruthy();
    const bravo = document.querySelector('[data-core-tile="b"]')!;
    expect(bravo.querySelector('[data-core-dot="offline"]')).toBeTruthy();
    expect(bravo.getAttribute("aria-label")).toBe("bravo, offline");
  });

  it("colours the dots and the attention badge with colour tokens that styles.css defines", async () => {
    cores = [core("a", "alpha")];
    rows = [
      { coreId: "a", status: "running" },
      { coreId: "a", status: "needs-input" },
    ];
    await mount();
    const css = readFileSync(path.resolve(__dirname, "../../../styles.css"), "utf8");
    const defined = (token: string) => new RegExp(`^\\s*${token}\\s*:`, "m").test(css);
    const tile = document.querySelector('[data-core-tile="a"]')!;
    const used = [
      ...tile.querySelectorAll<HTMLElement>("[data-core-dot]"),
      tile.querySelector<SVGElement>('[aria-label="Needs input"]')!,
    ].map((el) => {
      const raw = el.getAttribute("style") ?? "";
      return /var\((--[a-z-]+)/.exec(raw)?.[1] ?? null;
    });
    expect(used.length).toBe(3);
    for (const token of used) {
      expect(token, "an element carries no colour token").not.toBeNull();
      expect(defined(token!), `${token} is not defined in styles.css`).toBe(true);
    }
  });

  it("marks the Core the route is on", async () => {
    cores = [core("a", "alpha"), core("b", "bravo")];
    await mount("/cores/b");
    expect(document.querySelector('[data-core-tile="b"]')!.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('[data-core-tile="a"]')!.getAttribute("aria-current")).toBeNull();
  });

  it("opens the Nth Core on ctrl+N and swallows a digit past the last Core", async () => {
    cores = [core("c2", "build-box-01"), core("c1", "workstation-berlin")];
    await mount();
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(opened).toEqual(["c1"]);
    const beyond = new KeyboardEvent("keydown", { key: "5", ctrlKey: true, cancelable: true });
    window.dispatchEvent(beyond);
    expect(opened).toEqual(["c1"]);
    expect(beyond.defaultPrevented).toBe(true);
  });
});
