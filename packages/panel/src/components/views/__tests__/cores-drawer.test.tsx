// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { CoreWithDial } from "~/shared/cores";

// The Cores drawer replaces the rail on compact screens. It runs inside a REAL
// router: the rows are links and "closes on navigation" is route behaviour.

vi.mock("~/lib/api", () => ({
  api: { getAuthState: vi.fn(async () => ({ operator: { name: "Mehdi" } })) },
}));

const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory } =
  await import("@tanstack/react-router");
const { CoresDrawer, useCoresDrawerOpen } = await import("../CoresDrawer");
const { useIsCompact } = await import("~/lib/breakpoint");

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

const cores = [core("c2", "build-box-01"), core("c1", "workstation-berlin"), core("c3", "gpu-rig-02", "unreachable")];
const rows = [
  { coreId: "c1", status: "running" },
  { coreId: "c1", status: "done" },
  { coreId: "c1", status: "running" },
  { coreId: "c2", status: "needs-input" },
  { coreId: "c2", status: "ready" },
];

const onOpenSettings = vi.fn();
const onClose = vi.fn();

function Harness({ activeCoreId }: { activeCoreId: string | null }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" aria-label="Open Cores menu" onClick={() => setOpen(true)} />
      <CoresDrawer
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        cores={cores}
        fleet={{ rows }}
        activeCoreId={activeCoreId}
        onOpenSettings={onOpenSettings}
      />
    </>
  );
}

async function mount(path = "/", activeCoreId: string | null = null) {
  const root = createRootRoute({ component: () => <Harness activeCoreId={activeCoreId} /> });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const coreRoute = createRoute({ getParentRoute: () => root, path: "/cores/$coreId", component: () => null });
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

// jsdom has no matchMedia: answers "(max-width: Npx)" for a width the test
// sets, and fires change listeners (as in breakpoint.test.ts).
function stubMatchMedia(initialWidth: number) {
  let width = initialWidth;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return max ? width <= Number(max[1]) : false;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return {
    setWidth(next: number) {
      width = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

// The shell's wiring: the drawer exists only while compact.
function ShellHarness() {
  const compact = useIsCompact();
  const [open, setOpen] = useCoresDrawerOpen(compact);
  return (
    <>
      <button type="button" aria-label="Open Cores menu" onClick={() => setOpen(true)} />
      {compact ? (
        <CoresDrawer
          open={open}
          onClose={() => setOpen(false)}
          cores={cores}
          fleet={{ rows }}
          activeCoreId={null}
          onOpenSettings={onOpenSettings}
        />
      ) : null}
    </>
  );
}

async function mountShell() {
  const root = createRootRoute({ component: ShellHarness });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  onOpenSettings.mockClear();
  onClose.mockClear();
});

describe("CoresDrawer", () => {
  it("lists Fleet with active count, every Core with status and session count, Settings and Operator", async () => {
    await mount();
    const drawer = screen.getByRole("dialog", { name: "Cores" });
    expect(within(drawer).getByRole("link", { name: /Fleet/ }).textContent).toContain("3 active");
    expect(within(drawer).getByText("3 CORES")).toBeTruthy();
    const links = within(drawer).getAllByRole("link").map((a) => a.textContent ?? "");
    expect(links[1]).toContain("build-box-01");
    expect(links[1]).toContain("online · 2 sessions");
    expect(links[2]).toContain("gpu-rig-02");
    expect(links[2]).toContain("offline · 0 sessions");
    expect(links[3]).toContain("workstation-berlin");
    expect(links[3]).toContain("online · 3 sessions");
    expect(within(drawer).getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(await within(drawer).findByText("Mehdi")).toBeTruthy();
    expect(within(drawer).getByText("Operator")).toBeTruthy();
  });

  it("marks the current Core aria-current", async () => {
    await mount("/cores/c1", "c1");
    const current = screen.getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain("workstation-berlin");
  });

  it("shows a needs-input badge", async () => {
    await mount();
    expect(screen.getByText("1 needs input")).toBeTruthy();
    expect(screen.queryAllByText(/needs input/)).toHaveLength(1);
  });

  it("tapping a Core navigates to /cores/$id and closes the drawer", async () => {
    const router = await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: /workstation-berlin/ }));
    });
    expect(router.state.location.pathname).toBe("/cores/c1");
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Cores" })).toBeNull();
  });

  it("Escape and backdrop close it and focus returns to the menu button", async () => {
    await mount();
    const menu = screen.getByRole("button", { name: "Open Cores menu" });
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog", { name: "Cores" })).toBeNull();
    // reopen from the menu button so the drawer remembers where focus was
    act(() => menu.focus());
    await act(async () => {
      fireEvent.click(menu);
    });
    expect(screen.getByRole("dialog", { name: "Cores" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("cores-drawer-backdrop"));
    });
    expect(screen.queryByRole("dialog", { name: "Cores" })).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it("Tab and Shift+Tab stay inside the drawer", async () => {
    await mount();
    const drawer = screen.getByRole("dialog", { name: "Cores" });
    const operator = await within(drawer).findByRole("button", { name: /Operator/ });
    act(() => operator.focus());
    await act(async () => {
      fireEvent.keyDown(document, { key: "Tab" });
    });
    expect(document.activeElement).toBe(within(drawer).getByRole("link", { name: /Fleet/ }));
    act(() => drawer.focus());
    await act(async () => {
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    });
    expect(document.activeElement).toBe(operator);
  });

  it("does not reopen by itself after a round trip through desktop width", async () => {
    const media = stubMatchMedia(800);
    await mountShell();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open Cores menu" }));
    });
    expect(screen.getByRole("dialog", { name: "Cores" })).toBeTruthy();
    act(() => media.setWidth(1280));
    expect(screen.queryByRole("dialog", { name: "Cores" })).toBeNull();
    act(() => media.setWidth(800));
    expect(screen.queryByRole("dialog", { name: "Cores" })).toBeNull();
  });

  it('Settings and Operator call onOpenSettings (null / "operator")', async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    });
    expect(onOpenSettings).toHaveBeenLastCalledWith(null);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open Cores menu" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Operator/ }));
    });
    expect(onOpenSettings).toHaveBeenLastCalledWith("operator");
  });
});
