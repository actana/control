// @vitest-environment jsdom
//
// #832 M28/M29: plain user terminals on a phone — a full-screen view with Back,
// a scrolling tab strip, the key row and the switcher sheet. Edges are mocked:
// the store, the pane (xterm), the surface cache entry (writeToPty spy), the
// router and the Fleet context. Desktop is asserted unchanged at the end.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";

const noop = () => {};
const store = {
  coreId: "core1" as string | null,
  panelOpen: true,
  setPanelOpen: vi.fn(),
  panelMaximized: false,
  setPanelMaximized: vi.fn(),
  sessions: [] as unknown[],
  focusedId: "t1" as string | null,
  focusTerminal: vi.fn(),
  createVmShellTerminal: vi.fn(async () => null),
  killTerminal: vi.fn(async () => {}),
  hiddenIds: new Set<string>(),
  toggleHidden: vi.fn(),
  renameTerminal: vi.fn(),
  setPtyId: vi.fn(),
};
vi.mock("~/lib/user-terminal-store", () => ({ useUserTerminals: () => store }));

type PaneProps = { terminal: { id: string }; phone?: boolean; transformInput?: (d: string) => string };
const paneProps: PaneProps[] = [];
vi.mock("../UserTerminalPane", () => ({
  UserTerminalPane: (props: PaneProps) => {
    paneProps.push(props);
    return <div data-testid="pane" data-terminal-id={props.terminal.id} />;
  },
}));

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate }) }));
const requestSessionOpen = vi.fn();
vi.mock("~/lib/session-notification-store", () => ({ requestSessionOpen: (...a: unknown[]) => requestSessionOpen(...a) }));

const fleetRows = [
  { coreId: "core1", sessionId: "s1", title: "Implement issue 558", agent: "claude-code", status: "running", updatedAt: 1 },
  { coreId: "core1", sessionId: "s2", title: "Migrate sessions table", agent: "codex", status: "needs-input", updatedAt: 1 },
  { coreId: "other", sessionId: "s3", title: "Elsewhere", agent: "pi", status: "ready", updatedAt: 1 },
];
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({
    cores: [{ id: "core1", label: "workstation-berlin", dial: { coreId: "core1", state: "connected", lastSeenAt: 1 } }],
    fleet: { rows: fleetRows, offlineCores: [], singleCore: false },
  }),
}));

const { terminalSurfaceCache } = await import("~/lib/terminal-surface-cache");
const { UserTerminalPanel } = await import("../UserTerminalPanel");

function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
      dispatchEvent: () => false,
      onchange: null,
    };
  });
}

const writeToPty = vi.fn();
const paste = vi.fn();
function term(id: string, name: string) {
  return { terminal: { id, name, cwd: null }, ptyId: `pty-${id}`, coreId: "core1" };
}

function renderPanel() {
  paneProps.length = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <UserTerminalPanel />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = noop;
  Object.values(store).forEach((v) => (typeof v === "function" && "mockClear" in v ? (v as { mockClear(): void }).mockClear() : null));
  navigate.mockClear();
  requestSessionOpen.mockClear();
  writeToPty.mockClear();
  paste.mockClear();
  store.coreId = "core1";
  store.panelOpen = true;
  store.focusedId = "t1";
  store.sessions = [term("t1", "core@workstation-berlin"), term("t2", "htop")];
  terminalSurfaceCache.set({
    id: "t1",
    el: document.createElement("div"),
    buildKey: "0",
    ptyId: "pty-t1",
    destroyed: false,
    controls: { focus: noop, clear: noop, setFontSize: noop, writeToPty, paste },
    fit: noop,
    teardown: noop,
  } as never);
  stubWidth(390);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("user terminals on a phone (#832, M28)", () => {
  it("phone: the open terminal panel fills the screen with Back and the Core name", () => {
    renderPanel();
    const screenEl = document.querySelector("[data-user-terminal-screen]") as HTMLElement;
    expect(screenEl).toBeTruthy();
    expect(screenEl.style.position).toBe("fixed");
    expect(screenEl.style.zIndex).toBe("9000");
    expect(screenEl.parentElement).toBe(document.body);
    expect(within(screenEl).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(within(screenEl).getByText("workstation-berlin")).toBeTruthy();
    // Only the active shell is mounted, and it is told it is on a phone.
    expect(screen.getAllByTestId("pane").map((p) => p.dataset.terminalId)).toEqual(["t1"]);
    expect(paneProps.at(-1)!.phone).toBe(true);
    // No desktop chrome: no resize handle, no maximise.
    expect(screen.queryByTitle("Drag to resize")).toBeNull();
    expect(screen.queryByRole("button", { name: /maximise/i })).toBeNull();
  });

  it("phone: renders nothing while the panel is closed", () => {
    store.panelOpen = false;
    renderPanel();
    expect(document.querySelector("[data-user-terminal-panel]")).toBeNull();
  });

  it("phone: Back closes the panel", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(store.setPanelOpen).toHaveBeenCalledWith(false);
    expect(store.killTerminal).not.toHaveBeenCalled();
  });

  it("phone: tab strip lists each shell and switches on tap", () => {
    renderPanel();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["core@workstation-berlin", "htop"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(tabs[1]!);
    expect(store.focusTerminal).toHaveBeenCalledWith("t2");
  });

  it("phone: shows the focused shell, not the first, when another is active", () => {
    store.focusedId = "t2";
    renderPanel();
    expect(screen.getAllByTestId("pane").map((p) => p.dataset.terminalId)).toEqual(["t2"]);
  });

  it("phone: closing a tab from the strip", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Close htop" }));
    // Killing a shell is destructive: it asks first.
    expect(store.killTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(store.killTerminal).toHaveBeenCalledExactlyOnceWith("t2");
  });

  it("phone: + opens a new terminal", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "New Terminal" }));
    expect(store.createVmShellTerminal).toHaveBeenCalledExactlyOnceWith("core1");
  });

  it("phone: tabs, + and the switcher are at least 44 px tall targets", () => {
    renderPanel();
    const css = readFileSync(path.resolve(__dirname, "../../../styles/mobile-terminal.css"), "utf8");
    expect(css).toMatch(/\.mc-userterm-m-tab\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.mc-userterm-m-switch\s*\{[^}]*width:\s*44px/);
    expect(screen.getByRole("button", { name: "All terminals" })).toBeTruthy();
  });

  it("phone: key row sends to the active shell", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(writeToPty).toHaveBeenCalledWith("\x1b");
  });

  it("phone: key row Paste goes through the terminal's paste, not raw PTY bytes", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: vi.fn().mockResolvedValue("ls -la") } });
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    });
    expect(paste).toHaveBeenCalledWith("ls -la");
    expect(writeToPty).not.toHaveBeenCalled();
  });

  it("phone: Ctrl from the key row applies to the next typed char, not to auto-replies", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    const latest = paneProps.at(-1)!.transformInput!;
    expect(latest("\x1b[I")).toBe("\x1b[I");
    expect(latest("c")).toBe("\x03");
    expect(latest("c")).toBe("c");
  });
});

describe("terminal switcher sheet (#832, M29)", () => {
  function openSheet() {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "All terminals" }));
    return screen.getByRole("dialog", { name: "Core Terminals" });
  }

  it("phone: the switcher sheet lists shells and Sessions", () => {
    const dialog = openSheet();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText("Shells")).toBeTruthy();
    expect(within(dialog).getByText("Sessions")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "core@workstation-berlin" }).getAttribute("aria-current")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "Close htop" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /New Terminal/ })).toBeTruthy();
    expect(within(dialog).getByText("Implement issue 558")).toBeTruthy();
    expect(within(dialog).getByText("Running · claude-code")).toBeTruthy();
    expect(within(dialog).getByText("Needs-input · codex")).toBeTruthy();
    // Another Core's Session is not listed.
    expect(within(dialog).queryByText("Elsewhere")).toBeNull();
  });

  it("phone: tapping a shell in the switcher switches and closes the sheet", () => {
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "htop" }));
    expect(store.focusTerminal).toHaveBeenCalledWith("t2");
    expect(screen.queryByRole("dialog", { name: "Core Terminals" })).toBeNull();
  });

  it("phone: + New Terminal in the switcher opens a shell and closes the sheet", () => {
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole("button", { name: /New Terminal/ }));
    expect(store.createVmShellTerminal).toHaveBeenCalledExactlyOnceWith("core1");
    expect(screen.queryByRole("dialog", { name: "Core Terminals" })).toBeNull();
  });

  it("phone: tapping a Session in the switcher opens its terminal", () => {
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole("button", { name: /Migrate sessions table/ }));
    expect(requestSessionOpen).toHaveBeenCalledExactlyOnceWith("core1", "s2");
    expect(navigate).toHaveBeenCalledWith({ to: "/cores/$coreId/workspace", params: { coreId: "core1" } });
    expect(store.setPanelOpen).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog", { name: "Core Terminals" })).toBeNull();
  });

  it("phone: the switcher closes on Escape, backdrop and the handle", () => {
    openSheet();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Core Terminals" })).toBeNull();
    cleanup();
    openSheet();
    fireEvent.click(document.querySelector("[data-terminal-switcher-backdrop]")!);
    expect(screen.queryByRole("dialog", { name: "Core Terminals" })).toBeNull();
    cleanup();
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("dialog", { name: "Core Terminals" })).toBeNull();
  });

  it("phone: the switcher traps focus", () => {
    const dialog = openSheet();
    expect(document.activeElement).toBe(dialog);
    const buttons = within(dialog).getAllByRole("button");
    const last = buttons[buttons.length - 1]!;
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe("desktop", () => {
  it("desktop: user terminal drawer unchanged", () => {
    stubWidth(1280);
    renderPanel();
    expect(document.querySelector("[data-user-terminal-screen]")).toBeNull();
    // Tabs (hide/show), resize handle and maximise stay.
    expect(screen.getByRole("button", { name: "Hide terminal htop" })).toBeTruthy();
    expect(screen.getAllByTitle("Drag to resize").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /maximise terminal/i })).toBeTruthy();
    // No phone chrome.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "All terminals" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Esc" })).toBeNull();
    expect(paneProps.every((p) => !p.phone)).toBe(true);
  });
});
