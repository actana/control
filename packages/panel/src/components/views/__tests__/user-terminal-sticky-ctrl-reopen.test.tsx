// @vitest-environment jsdom
//
// #832: sticky Ctrl on the phone key row must keep working after the user
// terminal panel is closed and reopened. The xterm surface (and its once-wired
// `onData` handler) outlives the pane that built it, so the handler must reach
// the CURRENT pane's Ctrl. Edges mocked: xterm (a fake Terminal capturing its
// `onData` callback), the PTY link, the store, the router and the Fleet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";

const noop = () => {};
const store = {
  coreId: "core1" as string | null,
  panelOpen: true,
  setPanelOpen: vi.fn(),
  panelMaximized: false,
  setPanelMaximized: vi.fn(),
  sessions: [{ terminal: { id: "t1", name: "shell", cwd: null }, ptyId: null, coreId: "core1" }] as unknown[],
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
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));
vi.mock("~/lib/session-notification-store", () => ({ requestSessionOpen: vi.fn() }));
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({
    cores: [{ id: "core1", label: "workstation-berlin", dial: { coreId: "core1", state: "connected", lastSeenAt: 1 } }],
    fleet: { rows: [], offlineCores: [], singleCore: false },
  }),
}));
const ptyWrite = vi.fn(async () => true);
const ptyBridge = {
  spawn: async () => ({ ptyId: "pty-t1", hooksReportTurnStart: false }),
  submitPrompt: async () => true,
  write: ptyWrite,
  resize: async () => true,
  kill: async () => true,
  replay: async () => ({ data: "", nextSeq: 0 }),
  subscribe: async () => {},
  unsubscribe: async () => {},
  findBySession: async () => ({ ptyId: null }),
  onData: () => noop,
  onExit: () => noop,
  onReconnect: () => noop,
};
vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({}),
  getCorePtyBridge: () => ptyBridge,
}));
const dataHandlers: Array<(d: string) => void> = [];
const terms: FakeTerminal[] = [];
class FakeTerminal {
  constructor() {
    terms.push(this);
  }
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  modes = { applicationCursorKeysMode: false };
  buffer = { active: { type: "normal", length: 0, baseY: 0, cursorY: 0, getLine: () => undefined } };
  element = document.createElement("div");
  refresh() {}
  scrollToBottom() {}
  scrollToLine() {}
  loadAddon() {}
  open() {}
  focus() {}
  clear() {}
  reset() {}
  write() {}
  writeln() {}
  paste() {}
  dispose() {}
  attachCustomKeyEventHandler() {}
  registerLinkProvider() {
    return { dispose: noop };
  }
  onData(cb: (d: string) => void) {
    dataHandlers.push(cb);
    return { dispose: noop };
  }
  onResize() {
    return { dispose: noop };
  }
  onBell() {
    return { dispose: noop };
  }
  onTitleChange() {
    return { dispose: noop };
  }
}
class FakeFit {
  fit() {}
  proposeDimensions() {
    return { cols: 80, rows: 24 };
  }
}
vi.mock("~/lib/prefetch-terminal-modules", () => ({
  prefetchTerminalModules: async () => ({ Terminal: FakeTerminal, FitAddon: FakeFit }),
}));

const { terminalSurfaceCache } = await import("~/lib/terminal-surface-cache");
const { UserTerminalPanel } = await import("../UserTerminalPanel");

function stubPhone() {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? 390 <= Number(max[1]) : false,
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

function panel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <UserTerminalPanel />
      </KeybindingsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = noop;
  vi.stubGlobal("ResizeObserver", class { observe = noop; disconnect = noop; unobserve = noop; });
  stubPhone();
  dataHandlers.length = 0;
  terms.length = 0;
  store.panelOpen = true;
});
afterEach(() => {
  cleanup();
  terminalSurfaceCache.destroy("t1");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("phone: user terminal sticky Ctrl survives close and reopen", () => {
  it("Ctrl armed on the reopened key row applies to the next typed character", async () => {
    const view = render(panel());
    await waitFor(() => expect(dataHandlers).toHaveLength(1));
    // Back: the panel returns null, the pane unmounts, the surface is parked.
    store.panelOpen = false;
    view.rerender(panel());
    store.panelOpen = true;
    view.rerender(panel());
    // Reopen reattaches the surface; input is not wired a second time.
    expect(dataHandlers).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    expect(screen.getByRole("button", { name: "Ctrl" }).getAttribute("aria-pressed")).toBe("true");
    ptyWrite.mockClear();
    act(() => dataHandlers[0]!("c"));
    expect(ptyWrite).toHaveBeenCalledWith("pty-t1", "\x03");
    expect(screen.getByRole("button", { name: "Ctrl" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("key-row arrows send the application-cursor form while DECCKM is on", async () => {
    render(panel());
    await waitFor(() => expect(dataHandlers).toHaveLength(1));
    terms[0]!.modes.applicationCursorKeysMode = true;
    ptyWrite.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    expect(ptyWrite).toHaveBeenCalledWith("pty-t1", "\x1bOA");
  });
});
