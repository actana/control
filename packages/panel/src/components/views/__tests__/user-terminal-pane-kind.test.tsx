// @vitest-environment jsdom
//
// The other half of issue 394: the panel must hand each pane the Core the
// *session* ran on, never the one the current scope suggests — the session is
// restored correctly and then rendered somewhere else otherwise.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";

type PaneProps = {
  terminal: { id: string };
  coreId: string;
};

const store = {
  coreId: "core_route" as string | null,
  panelOpen: true,
  setPanelOpen: vi.fn(),
  panelMaximized: false,
  setPanelMaximized: vi.fn(),
  togglePanelMaximized: vi.fn(),
  sessions: [] as unknown[],
  focusedId: null,
  focusTerminal: vi.fn(),
  createVmShellTerminal: vi.fn(),
  killTerminal: vi.fn(),
  hiddenIds: new Set<string>(),
  toggleHidden: vi.fn(),
  renameTerminal: vi.fn(),
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

function session(id: string, coreId: string) {
  return { terminal: { id, name: id, cwd: null }, ptyId: null, coreId };
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

afterEach(() => cleanup());

describe("the panel renders the shell the session is (issue 394)", () => {
  it("hands a pane the Core its session ran on, not the Core in scope", () => {
    store.sessions = [session("t1", "core_a")];
    renderPanel();
    const pane = paneProps.at(-1)!;
    // The session's own Core wins over the Core the route is on: a restored
    // terminal carries the Core its identity recorded.
    expect(pane.coreId).toBe("core_a");
  });

  it("gives every pane its own session's Core", () => {
    store.sessions = [session("t1", "core_a"), session("t2", "core_b")];
    renderPanel();
    expect(paneProps.map((p) => [p.terminal.id, p.coreId])).toEqual([
      ["t1", "core_a"],
      ["t2", "core_b"],
    ]);
  });

  it("hands a pane no cwd and no shell kind: every terminal is a VM shell in the Core's home", () => {
    store.sessions = [session("t3", "core_a")];
    renderPanel();
    const pane = paneProps.at(-1)!;
    expect(pane).not.toHaveProperty("cwd");
    expect(pane).not.toHaveProperty("isHome");
    expect(pane).not.toHaveProperty("shellSession");
  });
});
