// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { Session } from "~/db/schema";
import { GRID_SHOW_SESSION_EVENT, clearPickedGridSessions, type GridShowSessionEventDetail } from "~/lib/grid-layout-prefs";

// #895: the grid layout menu lists the Core's Sessions so the operator can swap
// which ones the (capped) grid shows.

const session = (id: string, status: string, updatedAt = 1): Session =>
  ({
    id,
    title: `Title ${id}`,
    agent: "claude-code",
    status,
    archived: false,
    pinned: false,
    icon: null,
    createdAt: 0,
    updatedAt,
  }) as unknown as Session;

let rows: Session[] = [];
let openIds: string[] = [];
const rehydrate = vi.fn();

vi.mock("~/lib/terminal-store", () => ({
  useTerminals: () => ({
    sessions: openIds.map((id) => ({
      sessionId: id,
      coreId: "a",
      session: rows.find((r) => r.id === id)!,
    })),
    rehydrate,
  }),
}));

const { GridLayoutButton } = await import("../GridLayoutButton");

const events: GridShowSessionEventDetail[] = [];
const onShow = (e: Event) => events.push((e as CustomEvent<GridShowSessionEventDetail>).detail);

async function openMenu() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <KeybindingsProvider>
        <GridLayoutButton scopeKey="a:main" coreId="a" sessionRows={rows} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Grid layout" }));
  });
  return screen.getByRole("menu", { name: "Grid layout" });
}

beforeEach(() => {
  events.length = 0;
  rehydrate.mockClear();
  window.addEventListener(GRID_SHOW_SESSION_EVENT, onShow);
});
afterEach(() => {
  window.removeEventListener(GRID_SHOW_SESSION_EVENT, onShow);
  cleanup();
  clearPickedGridSessions("a:main");
  window.localStorage.clear();
});

describe("grid session picker (#895)", () => {
  it("lists the Core's Sessions with the shown ones checked and the count against the cap", async () => {
    rows = [session("a", "running"), session("b", "ready"), session("c", "finished")];
    openIds = ["a"];
    const menu = await openMenu();
    expect(within(menu).getByText("Sessions shown (1 of 8)")).toBeTruthy();
    const items = within(menu).getAllByRole("menuitemcheckbox");
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("swapping in a Session that is not open opens it and asks the grid to show it", async () => {
    rows = [session("a", "running"), session("b", "ready")];
    openIds = ["a"];
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /Title b/ }));
    expect(rehydrate).toHaveBeenCalledWith("a", rows[1], { openedByGrid: true });
    expect(events).toEqual([{ scopeKey: "a:main", sessionId: "b", show: true }]);
  });

  it("unchecking a shown Session asks the grid to hide it, keeping it open", async () => {
    rows = [session("a", "running"), session("b", "ready")];
    openIds = ["a", "b"];
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /Title a/ }));
    expect(events).toEqual([{ scopeKey: "a:main", sessionId: "a", show: false }]);
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it("at the cap, picking an unshown Session still asks the grid to show it (it takes a slot)", async () => {
    rows = Array.from({ length: 10 }, (_, i) => session(`s${i}`, "running", i));
    openIds = rows.map((r) => r.id);
    const menu = await openMenu();
    expect(within(menu).getByText("Sessions shown (8 of 8)")).toBeTruthy();
    const checked = within(menu)
      .getAllByRole("menuitemcheckbox")
      .filter((i) => i.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(8);
    const extra = within(menu).getByRole("menuitemcheckbox", { name: /Title s0/ });
    expect(extra.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(extra);
    expect(events).toEqual([{ scopeKey: "a:main", sessionId: "s0", show: true }]);
    // Now the swap is reflected: s0 is shown, still 8 of 8.
    expect(
      within(screen.getByRole("menu", { name: "Grid layout" })).getByRole("menuitemcheckbox", { name: /Title s0/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(menu).getByText("Sessions shown (8 of 8)")).toBeTruthy();
  });
});
