// @vitest-environment jsdom
//
// The Terminals button on a Core page toggles the terminal panel. On a browser that has never opened it the
// panel is closed, so the first toggle must open it (it used to "close" an already closed panel: the first tap on
// the phone did nothing, found by the phone e2e, #836).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

const listHomeTerminals = vi.fn();

vi.mock("~/lib/api", () => ({
  api: {
    listHomeTerminals: () => listHomeTerminals(),
    createHomeTerminal: vi.fn(),
    deleteHomeTerminal: vi.fn(),
    renameHomeTerminal: vi.fn(),
  },
}));
// A store test, not a terminal test: nothing here spawns a PTY or an xterm.
vi.mock("~/lib/panel-bridge", () => ({ getCorePtyBridge: () => null }));
vi.mock("~/lib/prefetch-terminal-modules", () => ({
  prefetchTerminalModules: async () => ({}),
}));
vi.mock("~/lib/terminal-surface-cache", () => ({
  terminalSurfaceCache: { get: () => null, set: vi.fn(), park: vi.fn(), destroy: vi.fn() },
}));

const { UserTerminalProvider, useUserTerminals } = await import("~/lib/user-terminal-store");


describe("togglePanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    listHomeTerminals.mockReset().mockResolvedValue({ terminals: [] });
  });
  afterEach(() => cleanup());

  it("opens a panel that has never been opened on the first call, and closes it on the second", async () => {
    const view = renderHook(() => useUserTerminals(), {
      wrapper: ({ children }: { children: ReactNode }) => <UserTerminalProvider>{children}</UserTerminalProvider>,
    });
    await act(async () => {
      view.result.current.setCore("core_a");
    });
    expect(view.result.current.panelOpen).toBe(false);
    await act(async () => {
      view.result.current.togglePanel();
    });
    expect(view.result.current.panelOpen).toBe(true);
    await act(async () => {
      view.result.current.togglePanel();
    });
    expect(view.result.current.panelOpen).toBe(false);
  });
});
