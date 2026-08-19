// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";

// The panel had no test for either creator, which is how three buttons for two
// behaviours went unnoticed (issue 266 §A.2). This is that test, and it asserts
// the thing the issue is about rather than the markup around it: **one control
// per place one is offered, called "New Terminal", and it opens a VM Shell
// Session.**
//
// The store is mocked rather than provided, because what is under test is the
// wiring between a button and a creator — not `api`, not the PTY bridge, and
// not a pane that would drag xterm into jsdom.

const createVmShellTerminal = vi.fn(async () => null);
const store = {
  project: null as unknown,
  homeActive: true,
  panelOpen: false,
  setPanelOpen: vi.fn(),
  sessions: [] as unknown[],
  focusedId: null,
  focusTerminal: vi.fn(),
  createVmShellTerminal,
  killTerminal: vi.fn(),
  hiddenIds: new Set<string>(),
  toggleHidden: vi.fn(),
  renameTerminal: vi.fn(),
  updateLaunchUrl: vi.fn(),
  setPtyId: vi.fn(),
};

vi.mock("~/lib/user-terminal-store", () => ({
  useUserTerminals: () => store,
}));
// The pane pulls in xterm and the terminal surface cache; neither is what this
// suite is about, and the empty state renders without one anyway.
vi.mock("../UserTerminalPane", () => ({
  UserTerminalPane: () => null,
}));

const { UserTerminalPanel } = await import("../UserTerminalPanel");

/**
 * The panel's chrome reads settings through react-query and the hotkey tooltip
 * reads the binding for `terminal.newTab`; both are ambient providers rather
 * than anything this suite is asserting on.
 */
function renderPanel(coreId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <UserTerminalPanel coreId={coreId} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  createVmShellTerminal.mockClear();
  store.sessions = [];
});
afterEach(() => cleanup());

/** Every enabled control this panel offers, by accessible name. */
function buttonNames(): string[] {
  return screen
    .getAllByRole("button")
    .map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim())
    .filter(Boolean);
}

describe("the terminal panel's one control (issue 266)", () => {
  it("offers exactly one control that opens a terminal, in each place it offers one", () => {
    renderPanel("core_a");
    const opens = buttonNames().filter((n) => /terminal/i.test(n) && !/collapse|expand/i.test(n));
    // The header toolbar and the empty state, one each — never a second
    // spelling of the same thing beside either.
    expect(opens).toEqual(["New Terminal", "New Terminal"]);
  });

  it("has no `New VM shell` button any more — the surviving control is that button", () => {
    renderPanel("core_a");
    expect(screen.queryByRole("button", { name: /vm shell/i })).toBeNull();
  });

  it("opens a VM Shell Session on the route's Core when the toolbar control is clicked", () => {
    renderPanel("core_a");
    screen.getAllByRole("button", { name: "New Terminal" })[0]!.click();
    expect(createVmShellTerminal).toHaveBeenCalledExactlyOnceWith("core_a");
  });

  it("opens the same thing from the empty state", () => {
    renderPanel("core_a");
    screen.getAllByRole("button", { name: "New Terminal" })[1]!.click();
    expect(createVmShellTerminal).toHaveBeenCalledExactlyOnceWith("core_a");
  });

  it("says nothing about a project shell in the empty state", () => {
    renderPanel("core_a");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/in this project/i);
    expect(text).not.toMatch(/home directory/i);
    expect(text).toMatch(/shell on this Core/i);
  });

  it("disables the control with no Core in scope — there is no machine to open a shell on", () => {
    renderPanel();
    for (const button of screen.getAllByRole("button", { name: "New Terminal" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
