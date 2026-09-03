// @vitest-environment jsdom
//
// The other half of issue 394: the panel must hand each pane the shell the
// *session* says it is, never the one the current scope suggests. Reading kind
// and cwd off the ambient scope is what let a reload spawn a home shell where
// the operator had opened a VM shell — the session is restored correctly and
// then rendered as something else.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";

type PaneProps = {
  terminal: { id: string };
  cwd: string;
  coreId?: string;
  isHome?: boolean;
  shellSession?: boolean;
};

const store = {
  project: { id: "p1", path: "/w/p1" } as unknown,
  homeActive: true,
  panelOpen: true,
  setPanelOpen: vi.fn(),
  sessions: [] as unknown[],
  focusedId: null,
  focusTerminal: vi.fn(),
  createVmShellTerminal: vi.fn(),
  killTerminal: vi.fn(),
  hiddenIds: new Set<string>(),
  toggleHidden: vi.fn(),
  renameTerminal: vi.fn(),
  updateLaunchUrl: vi.fn(),
  setPtyId: vi.fn(),
};
vi.mock("~/lib/user-terminal-store", () => ({ useUserTerminals: () => store }));

const paneProps: PaneProps[] = [];
// The pane itself drags xterm into jsdom; what is asserted here is the props it
// is handed, which is exactly where the kind was being lost.
vi.mock("../UserTerminalPane", () => ({
  UserTerminalPane: (props: PaneProps) => {
    paneProps.push(props);
    return null;
  },
}));

const { UserTerminalPanel } = await import("../UserTerminalPanel");

function session(id: string, kind: "vm-shell" | "home" | "project", cwd: string, coreId?: string) {
  return { terminal: { id, name: id, cwd: null }, ptyId: null, kind, cwd, coreId };
}

function renderPanel(coreId?: string) {
  paneProps.length = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <UserTerminalPanel coreId={coreId} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("the panel renders the shell the session is (issue 394)", () => {
  it("keeps a restored VM shell a VM shell, even while Home is the current scope", () => {
    store.sessions = [session("t1", "vm-shell", "", "core_a")];
    renderPanel("core_route");
    const pane = paneProps.at(-1)!;
    expect(pane.shellSession).toBe(true);
    // `isHome` used to be the ambient scope flag; a VM shell is not a home shell.
    expect(pane.isHome).toBe(false);
    // The session's own Core wins over the route's.
    expect(pane.coreId).toBe("core_a");
    expect(pane.cwd).toBe("");
  });

  it("spawns a home shell only for a session that is one", () => {
    store.sessions = [session("t2", "home", "", "core_a")];
    renderPanel("core_route");
    const pane = paneProps.at(-1)!;
    expect(pane.isHome).toBe(true);
    expect(pane.shellSession).toBe(false);
  });

  it("gives a project shell the cwd it was opened with, not the project in scope", () => {
    store.sessions = [session("t3", "project", "/w/other", "core_a")];
    renderPanel("core_route");
    const pane = paneProps.at(-1)!;
    expect(pane.shellSession).toBe(false);
    expect(pane.isHome).toBe(false);
    expect(pane.cwd).toBe("/w/other");
  });

  it("falls back to the route's Core for a session opened without one", () => {
    store.sessions = [session("t4", "vm-shell", "", undefined)];
    renderPanel("core_route");
    expect(paneProps.at(-1)!.coreId).toBe("core_route");
  });
});
