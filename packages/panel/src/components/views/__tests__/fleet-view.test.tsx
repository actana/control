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

afterEach(() => {
  cleanup();
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
