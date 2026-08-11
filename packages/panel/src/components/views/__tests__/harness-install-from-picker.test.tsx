// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  HARNESSES_AVAILABILITY_EVENT_KIND,
  HARNESS_INSTALL_FAILED_EVENT_KIND,
  type CoreLinkEvent,
  type CoreLinkHarnessAvailabilityMap,
} from "@actana/shared/core-link-frames";

// Installing a missing Harness from the "Start a new session" picker (issue 83).
//
// A missing CLI used to be a wall: the row greyed out and the operator was told
// to go run a command on another machine. Now the Core that owns that machine
// installs it, and the row follows the install the whole way — through the
// re-probe's `checking`, through an unchanged `missing`, to `available`.

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
vi.mock("~/queries", () => ({ useSettings: () => ({ data: undefined }) }));
// Mutable, so a test can put the registry poll's answer through a rename
// (issue 19) rather than only ever seeing the name a Core paired with.
let CORES = [{ id: "core_a", label: "Core A" }];

vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({ cores: CORES }),
}));
vi.mock("~/lib/api", () => ({ api: { getKeybindings: async () => ({ bindings: {} }) } }));

const { NewHarnessDialog } = await import("../NewHarnessDialog");
const { KeybindingsProvider } = await import("~/lib/keybindings/store");
const { __resetCliAvailabilityStoresForTests } = await import("~/lib/cli-availability");

/** Claude Code missing, Codex available — one row to install, one to fall back to. */
let AVAILABILITY: CoreLinkHarnessAvailabilityMap = {};

function availability(claude: CoreLinkHarnessAvailabilityMap["x"]): CoreLinkHarnessAvailabilityMap {
  return {
    "claude-code": claude,
    codex: { status: "available", path: "/usr/bin/codex" },
    "cursor-cli": { status: "available", path: "/usr/bin/cursor-agent" },
    opencode: { status: "available", path: "/usr/bin/opencode" },
  };
}

const PROJECT = {
  id: "p1",
  name: "Warehouse",
  path: "/srv/warehouse",
  savedHarness: "codex",
  rememberHarnessSettings: false,
} as never;

/** Push one Core event onto every live listener, as the panel link would. */
function emit(kind: string, payload: unknown): void {
  act(() => {
    for (const cb of listeners) {
      cb({
        coreId: "core_a",
        event: { eventId: 1, ts: 0, kind, ptyId: null, taskId: null, payload: JSON.stringify(payload) },
      });
    }
  });
}

function publishAvailability(map: CoreLinkHarnessAvailabilityMap): void {
  emit(HARNESSES_AVAILABILITY_EVENT_KIND, { availability: map });
}

async function openPicker(): Promise<void> {
  render(
    <KeybindingsProvider>
      <NewHarnessDialog
        open
        project={PROJECT}
        coreId="core_a"
        onClose={() => {}}
        onStart={() => {}}
        onPersistRemember={() => {}}
      />
    </KeybindingsProvider>,
  );
  // Let the availability hydration settle before the first assertion.
  await act(async () => {});
}

/** The row button for a Harness — the card, not the Install button beside it. */
function row(label: string): HTMLElement {
  // The logo's <title> carries the same label, so pick the row's own heading.
  const heading = screen.getAllByText(label).find((el) => el.tagName === "DIV");
  const button = heading?.closest("button");
  if (!button) throw new Error(`no row for ${label}`);
  return button;
}

function installButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Install$/ });
}

describe("installing a missing Harness from the picker (issue 83)", () => {
  beforeEach(() => {
    AVAILABILITY = availability({ status: "missing", reason: "not-found" });
    CORES = [{ id: "core_a", label: "Core A" }];
    listeners.clear();
    __resetCliAvailabilityStoresForTests();
    bridge.installHarness.mockClear();
    bridge.installHarness.mockResolvedValue({ accepted: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("offers Install on a missing Harness instead of disabling the row", async () => {
    await openPicker();

    expect(installButton()).toBeTruthy();
    expect(row("Claude Code").hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("CLI not found on PATH.")).toBeTruthy();
  });

  // Issue 19: the alias is Panel-local and editable, and this dialog resolves it
  // per render for its install copy. So an operator who renamed a machine is
  // told to install on the name they use for it now, not the one it paired with.
  it("names the Core by its current alias after a rename", async () => {
    // A fresh element each time: React skips a re-render handed back the same
    // element object, and it is the re-render that re-resolves the alias.
    const ui = () => (
      <KeybindingsProvider>
        <NewHarnessDialog
          open
          project={PROJECT}
          coreId="core_a"
          onClose={() => {}}
          onStart={() => {}}
          onPersistRemember={() => {}}
        />
      </KeybindingsProvider>
    );
    const { rerender } = render(ui());
    await act(async () => {});
    expect(installButton().title).toMatch(/ on Core A$/);

    // The registry poll comes back with the operator's new name for that Core.
    CORES = [{ id: "core_a", label: "build-box" }];
    await act(async () => {
      rerender(ui());
    });

    expect(installButton().title).toMatch(/ on build-box$/);
  });

  it("asks the Core that owns the picker's Task to install that Harness", async () => {
    await openPicker();

    await act(async () => {
      fireEvent.click(installButton());
    });

    expect(bridge.installHarness).toHaveBeenCalledWith("core_a", "claude-code");
  });

  it("stays installing across the re-probe's checking and an unchanged missing", async () => {
    await openPicker();
    await act(async () => {
      fireEvent.click(installButton());
    });
    expect(screen.getByText(/Installing on Core A/)).toBeTruthy();

    // The Core's post-install re-probe legitimately passes through `checking`,
    // and an ordinary refresh republishes the same `missing`. Neither is an
    // outcome, so neither may clear or flicker the row.
    publishAvailability(availability({ status: "checking" }));
    expect(screen.getByText(/Installing on Core A/)).toBeTruthy();

    publishAvailability(availability({ status: "missing", reason: "not-found" }));
    expect(screen.getByText(/Installing on Core A/)).toBeTruthy();
    expect(screen.queryByText("CLI not found on PATH.")).toBeNull();
  });

  it("clears installing when availability flips to available, and selects that row", async () => {
    await openPicker();
    // The dialog starts on Codex — Claude Code was missing when it opened.
    expect(row("Codex").getAttribute("style")).toContain("accent");

    await act(async () => {
      fireEvent.click(installButton());
    });
    publishAvailability(availability({ status: "available", path: "/usr/bin/claude" }));

    expect(screen.queryByText(/Installing on Core A/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Install$/ })).toBeNull();
    // The operator asked for this Harness by installing it — it wins the
    // selection over the one the picker fell back to.
    expect(row("Claude Code").getAttribute("style")).toContain("accent");
    expect(row("Claude Code").hasAttribute("disabled")).toBe(false);
  });

  it("returns the row to plain missing with the Core's message on a failure, and retries", async () => {
    await openPicker();
    await act(async () => {
      fireEvent.click(installButton());
    });

    emit(HARNESS_INSTALL_FAILED_EVENT_KIND, {
      harness: "claude-code",
      message: "Installing Claude Code on this Core failed.",
    });

    expect(screen.queryByText(/Installing on Core A/)).toBeNull();
    expect(screen.getByText("Installing Claude Code on this Core failed.")).toBeTruthy();

    // Clickable again: a failed install is a retry, not a dead row.
    await act(async () => {
      fireEvent.click(installButton());
    });
    expect(bridge.installHarness).toHaveBeenCalledTimes(2);
  });

  it("ends the attempt when the Core refuses to start it at all", async () => {
    bridge.installHarness.mockResolvedValue({
      accepted: false,
      message: "This Core cannot install Harnesses.",
    });
    await openPicker();

    await act(async () => {
      fireEvent.click(installButton());
    });

    expect(screen.queryByText(/Installing on Core A/)).toBeNull();
    expect(screen.getByText("This Core cannot install Harnesses.")).toBeTruthy();
  });

  it("does not let a missing Harness be started", async () => {
    await openPicker();

    // Selecting it is what the Start button gates on, and a missing Harness
    // cannot be selected — clicking the card leaves the selection where it was.
    await act(async () => {
      fireEvent.click(row("Claude Code"));
    });
    expect(row("Codex").getAttribute("style")).toContain("accent");
  });
});
