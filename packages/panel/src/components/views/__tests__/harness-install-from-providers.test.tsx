// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  HARNESSES_AVAILABILITY_EVENT_KIND,
  HARNESS_INSTALL_FAILED_EVENT_KIND,
  type CoreLinkEvent,
  type CoreLinkHarnessAvailabilityMap,
} from "@actana/sdk/core";

// Installing a missing Harness from Settings › Providers (issue 560): New
// Session lists only harnesses the Core has; Install lives here instead.

type EventListener = (msg: { coreId: string; event: CoreLinkEvent }) => void;

const listeners = new Set<EventListener>();

const bridge = {
  isConnected: () => true,
  listHarnessAvailability: vi.fn(async (): Promise<CoreLinkHarnessAvailabilityMap> => AVAILABILITY),
  installHarness: vi.fn(
    async (_coreId: string, _harness: string): Promise<{ accepted: boolean; message?: string }> => ({
      accepted: true,
    }),
  ),
  watchCore: vi.fn(() => () => {}),
  onEvent: vi.fn((cb: EventListener) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }),
};

vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => bridge }));
vi.mock("~/queries", () => ({
  useSettings: () => ({
    data: {
      harnessLauncherConfig: {
        order: ["claude-code", "codex", "cursor-cli", "opencode"],
        hidden: [],
      },
    },
  }),
  useHarnessAccounts: () => ({ data: [] }),
  useHarnessLatestVersions: () => ({ data: [] }),
  queryKeys: {
    settings: ["settings"],
    harnessLatestVersions: ["harnessLatestVersions"],
  },
}));
vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({ cores: [{ id: "core_a", label: "Core A" }] }),
}));
vi.mock("~/lib/selected-core-store", () => ({
  useSelectedCoreId: () => "core_a",
}));
vi.mock("~/lib/api", () => ({
  api: {
    getKeybindings: async () => ({ bindings: {} }),
    updateSettings: async (s: unknown) => s,
    getHarnessLatestVersions: async () => ({ versions: [] }),
  },
}));

const { ProvidersSettingsPage } = await import("../ProvidersSettingsPage");
const { KeybindingsProvider } = await import("~/lib/keybindings/store");
const { __resetCliAvailabilityStoresForTests } = await import("~/lib/cli-availability");

let AVAILABILITY: CoreLinkHarnessAvailabilityMap = {};

function availability(claude: CoreLinkHarnessAvailabilityMap["x"]): CoreLinkHarnessAvailabilityMap {
  return {
    "claude-code": claude,
    codex: { status: "available", path: "/usr/bin/codex" },
    "cursor-cli": { status: "available", path: "/usr/bin/cursor-agent" },
    opencode: { status: "available", path: "/usr/bin/opencode" },
  };
}

function emit(kind: string, payload: unknown): void {
  act(() => {
    for (const cb of listeners) {
      cb({
        coreId: "core_a",
        event: { eventId: 1, ts: 0, kind, ptyId: null, sessionId: null, payload: JSON.stringify(payload) },
      });
    }
  });
}

function publishAvailability(map: CoreLinkHarnessAvailabilityMap): void {
  emit(HARNESSES_AVAILABILITY_EVENT_KIND, { availability: map });
}

async function openProviders(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <ProvidersSettingsPage />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
  await act(async () => {});
}

function installButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Install$/ });
}

describe("installing a missing Harness from Providers (issue 560)", () => {
  beforeEach(() => {
    AVAILABILITY = availability({ status: "missing", reason: "not-found" });
    listeners.clear();
    __resetCliAvailabilityStoresForTests();
    bridge.installHarness.mockClear();
    bridge.installHarness.mockResolvedValue({ accepted: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("offers Install on a missing Harness", async () => {
    await openProviders();
    expect(installButton()).toBeTruthy();
    expect(screen.getByText("CLI not found on PATH")).toBeTruthy();
  });

  it("shows a Harness the Core could not start for its setup check as 'Could not start', with no Install (#700)", async () => {
    AVAILABILITY = availability({
      status: "missing",
      reason: "setup-check-failed: posix_spawnp failed: EACCES",
      path: "/usr/bin/claude",
      version: "2.1.289",
    });
    await openProviders();
    expect(screen.getByText("Could not start")).toBeTruthy();
    expect(screen.getByText("Could not start: posix_spawnp failed: EACCES")).toBeTruthy();
    expect(screen.queryByText(/Needs setup/)).toBeNull();
    expect(screen.queryByText("CLI not found on PATH")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Install$/ })).toBeNull();
  });

  it("asks the selected Core to install that Harness", async () => {
    await openProviders();
    await act(async () => {
      fireEvent.click(installButton());
    });
    expect(bridge.installHarness).toHaveBeenCalledWith("core_a", "claude-code");
  });

  it("stays installing across checking and an unchanged missing", async () => {
    await openProviders();
    await act(async () => {
      fireEvent.click(installButton());
    });
    expect(screen.getByText(/Installing on Core A/)).toBeTruthy();

    publishAvailability(availability({ status: "checking" }));
    expect(screen.getByText(/Installing on Core A/)).toBeTruthy();

    publishAvailability(availability({ status: "missing", reason: "not-found" }));
    expect(screen.getByText(/Installing on Core A/)).toBeTruthy();
  });

  it("clears installing when availability flips to available", async () => {
    await openProviders();
    await act(async () => {
      fireEvent.click(installButton());
    });
    publishAvailability(availability({ status: "available", path: "/usr/bin/claude" }));

    expect(screen.queryByText(/Installing on Core A/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Install$/ })).toBeNull();
  });

  it("returns to plain missing with the Core's message on failure, and retries", async () => {
    await openProviders();
    await act(async () => {
      fireEvent.click(installButton());
    });

    emit(HARNESS_INSTALL_FAILED_EVENT_KIND, {
      harness: "claude-code",
      message: "Installing Claude Code on this Core failed.",
    });

    expect(screen.queryByText(/Installing on Core A/)).toBeNull();
    expect(screen.getByText("Installing Claude Code on this Core failed.")).toBeTruthy();

    await act(async () => {
      fireEvent.click(installButton());
    });
    expect(bridge.installHarness).toHaveBeenCalledTimes(2);
  });
});
