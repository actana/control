// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";

// Fleet home: Sessions grouped by Core, a Pair a Core entry, and no project
// anywhere on it.

let cores: CoreWithDial[] = [];
let rows: Record<string, unknown>[] = [];

vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({
    cores,
    fleet: { rows, offlineCores: [], singleCore: false },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory } =
  await import("@tanstack/react-router");
const { FleetView } = await import("../FleetView");
const { OPEN_SETTINGS_EVENT } = await import("~/lib/design-meta");

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

function row(coreId: string, sessionId: string, title: string) {
  return {
    coreId,
    coreLabel: coreId,
    sessionId,
    title,
    agent: "claude-code",
    status: "running",
    updatedAt: Date.now(),
  };
}

async function mount() {
  const root = createRootRoute();
  const index = createRoute({ getParentRoute: () => root, path: "/", component: FleetView });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <KeybindingsProvider>
          <RouterProvider router={router} />
        </KeybindingsProvider>
      </QueryClientProvider>,
    );
    await router.load();
  });
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  rows = [];
});

describe("FleetView", () => {
  it("groups Sessions under their Core with no project level in between", async () => {
    cores = [core("a", "workstation-berlin"), core("b", "build-box-01")];
    rows = [
      row("a", "s1", "Refactor executor"),
      row("a", "s2", "Add Linear trigger"),
      row("b", "s3", "Reindex embeddings"),
    ];
    await mount();
    const section = (id: string) => document.querySelector<HTMLElement>(`[data-core-section="${id}"]`)!;
    const berlin = section("a");
    expect(within(berlin).getByText("Refactor executor")).toBeTruthy();
    expect(within(berlin).getByText("Add Linear trigger")).toBeTruthy();
    expect(within(berlin).queryByText("Reindex embeddings")).toBeNull();
    expect(within(section("b")).getByText("Reindex embeddings")).toBeTruthy();
    // Core is the only grouping level: a section per Core, nothing inside it.
    expect(berlin.querySelectorAll("[data-core-section]")).toHaveLength(0);
  });

  it("still lists a Core with no Sessions, and says an unreachable one is not reachable", async () => {
    cores = [core("a", "alpha"), core("g", "gpu-rig-02", "unreachable")];
    await mount();
    expect(screen.getByText("no active sessions")).toBeTruthy();
    expect(screen.getByText("no sessions to show")).toBeTruthy();
  });

  it("offers Pair a Core, which opens Settings on Cores, and no Add project", async () => {
    cores = [core("a", "alpha")];
    const seen: unknown[] = [];
    window.addEventListener(OPEN_SETTINGS_EVENT, (e) => seen.push((e as CustomEvent).detail));
    await mount();
    expect(screen.queryByText(/add project/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Pair a Core/ }));
    expect(seen).toEqual([{ panel: "cores" }]);
  });
});

// #831: phone (M07, M09) and tablet (M07 tablet) drop the h1 and the frame; desktop keeps today's header.
describe("FleetView on compact viewports", () => {
  const picker = () => screen.getByRole("combobox", { name: "Open a Core" }).parentElement as HTMLElement;
  const action = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

  it("desktop keeps the Fleet h1, the framed header and the 36 px picker", async () => {
    stubWidth(1280);
    cores = [core("a", "alpha")];
    rows = [row("a", "s1", "Refactor executor")];
    await mount();
    expect(screen.getByRole("heading", { level: 1, name: "Fleet" })).toBeTruthy();
    expect(document.querySelector("[data-fleet-compact]")).toBeNull();
    expect(document.querySelector(".mc-card-frame")).not.toBeNull();
    expect(picker().style.height).toBe("36px");
    expect(picker().style.flex).toBe("");
    expect(action("Tasks").style.minHeight).toBe("");
    const header = screen.getByRole("heading", { level: 1 }).parentElement!.parentElement as HTMLElement;
    expect(header.style.padding).toBe("28px 24px 24px");
    expect(header.style.margin).toBe("-8px -8px 28px");
    const open = screen.getByRole("button", { name: /Open alpha/ });
    expect(open.style.minHeight).toBe("");
    const rowButton = screen.getByText("Refactor executor").closest("button")!;
    expect(rowButton.style.minHeight).toBe("");
    expect(rowButton.style.padding).toBe("10px 14px");
  });

  // jsdom cannot lay out, so the wrap is asserted through the flex styles: a 260 px picker basis plus the actions
  // (about 270 px) wrap at 390 - 32 px and fit beside each other at 744 - 32 px.
  const headerRow = () => {
    const row = document.querySelector<HTMLElement>("[data-fleet-header-row]")!;
    const actions = document.querySelector<HTMLElement>("[data-fleet-actions]")!;
    expect(row.style.display).toBe("flex");
    expect(row.style.flexWrap).toBe("wrap");
    expect(picker().parentElement).toBe(row);
    expect(actions.parentElement).toBe(row);
    expect(picker().style.flex).toBe("1 1 260px");
    expect(actions.style.flex).toBe("1 0 auto");
    expect(actions.style.justifyContent).toBe("space-evenly");
    return actions;
  };

  it("phone: no h1, summary at 14 px, a 44 px picker that wraps the three actions onto an even row below", async () => {
    stubWidth(390);
    cores = [core("a", "workstation-berlin"), core("b", "build-box-01"), core("g", "gpu-rig-02", "unreachable")];
    rows = [row("a", "s1", "Refactor executor retry loop")];
    await mount();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const page = document.querySelector<HTMLElement>('[data-fleet-compact="phone"]')!;
    expect(page.style.padding).toBe("16px");
    expect(document.querySelector(".mc-card-frame")).toBeNull();
    const summary = screen.getByText("1 active session across 3 Cores");
    expect(summary.style.fontSize).toBe("14px");
    expect(picker().style.height).toBe("44px");
    const actions = headerRow();
    expect(actions.contains(picker())).toBe(false);
    for (const name of ["Tasks", "Pair a Core", "Refresh"]) {
      expect(actions.contains(action(name))).toBe(true);
      expect(action(name).style.minHeight).toBe("44px");
    }
    expect(screen.getByRole("button", { name: /Open workstation-berlin/ }).style.minHeight).toBe("44px");
    const rowButton = screen.getByText("Refactor executor retry loop").closest("button")!;
    expect(rowButton.style.minHeight).toBe("56px");
  });

  it("phone: an unreachable Core's detail wraps onto its own line, then 'no sessions to show'", async () => {
    stubWidth(390);
    const g = core("g", "gpu-rig-02", "unreachable");
    g.dial = { ...g.dial, detail: "connect ETIMEDOUT 10.0.4.12:8443" };
    cores = [g];
    await mount();
    const detail = document.querySelector<HTMLElement>("[data-dial-detail]")!;
    expect(detail.textContent).toBe("connect ETIMEDOUT 10.0.4.12:8443");
    expect(detail.style.flexBasis).toBe("100%");
    expect(detail.parentElement!.style.flexWrap).toBe("wrap");
    expect(screen.getByText("no sessions to show")).toBeTruthy();
  });

  it("phone with no Cores: summary, picker and actions, then Add your first Core", async () => {
    stubWidth(390);
    cores = [];
    await mount();
    expect(screen.getByText("0 active sessions across 0 Cores")).toBeTruthy();
    expect(picker()).toBeTruthy();
    expect(action("Pair a Core")).toBeTruthy();
    expect(screen.getByText("Add your first Core")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("744 px (a phone by lib/breakpoint, M07 tablet frame): picker and actions share the one wrapping row", async () => {
    stubWidth(744);
    cores = [core("a", "alpha")];
    await mount();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-fleet-compact="phone"]')!.style.padding).toBe("16px");
    headerRow();
    expect(picker().style.height).toBe("44px");
    expect(action("Refresh").style.minHeight).toBe("44px");
  });

  it("tablet (768-1023): the same row with 24 px page padding", async () => {
    stubWidth(800);
    cores = [core("a", "alpha")];
    await mount();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-fleet-compact="tablet"]')!.style.padding).toBe("24px");
    headerRow();
    expect(action("Refresh").style.minHeight).toBe("44px");
  });
});
