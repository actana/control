// @vitest-environment jsdom
//
// #832: sticky Ctrl on the phone key row must keep working after Back and
// reopen. The xterm surface (and its once-wired `onData` handler) outlives the
// pane that built it, so the handler must reach the CURRENT pane's Ctrl. Edges
// mocked: xterm (a fake Terminal capturing its `onData` callback), the PTY
// link, the stores.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { Session } from "~/db/schema";
import type { PendingQuestion } from "~/shared/harness-questions";

const SESSION_ID = "s1";
const session = {
  id: SESSION_ID,
  title: "Implement #558: pairing form",
  agent: "claude-code",
  status: "running",
  pinned: false,
  archived: false,
  icon: null,
  createdAt: 0,
  updatedAt: Date.now() - 2 * 60_000,
} as unknown as Session;

const state = {
  session: session as Session,
  question: null as PendingQuestion | null,
  writable: true,
};
const noop = () => {};
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("~/lib/terminal-store", () => ({
  useTerminals: () => ({ gridFocusRequest: null, consumeGridFocusRequest: () => false }),
  useTerminalActions: () => ({ syncSession: noop }),
}));
const mutateSession = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("~/lib/mutate-session-for-core", () => ({ mutateSessionForCore: mutateSession }));
vi.mock("~/lib/user-terminal-store", () => ({ useUserTerminals: () => ({ panelOpen: false }) }));
vi.mock("~/lib/use-hotkey", () => ({ useHotkey: noop }));
const ptyWrite = vi.fn(async () => true);
const ptyBridge = {
  spawn: async () => ({ ptyId: "pty1", hooksReportTurnStart: false }),
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
vi.mock("~/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/queries")>()),
  useSettings: () => ({ data: undefined }),
  useSession: () => ({ data: state.session }),
}));
vi.mock("~/lib/session-write-store", () => ({
  onSessionDriveHandover: () => noop,
  releaseSessionDrive: noop,
  takeSessionDrive: noop,
  watchSessionDrive: noop,
  useSessionWriteState: () => ({
    access: state.writable ? { writable: true } : { writable: false, reason: "held-by-another-client" },
    lock: { supported: false, state: "unlocked" },
    drive: "none",
    optimistic: false,
  }),
}));
vi.mock("~/lib/harness-question-store", () => ({
  dismissQuestionLocally: noop,
  getCurrentQuestionId: () => state.question?.id ?? null,
  getHoldQuestion: () => null,
  hydrateSessionQuestion: async () => {},
  isQuestionDesynced: () => false,
  markQuestionDesynced: noop,
  subscribeQuestionStore: () => noop,
  useQuestionDesynced: () => false,
  useQuestionDismissed: () => false,
  useSessionQuestion: () => state.question,
}));
vi.mock("~/components/views/SessionNotificationsButton", () => ({
  SessionNotificationsButton: () => <button aria-label="Notifications" />,
}));


const { terminalSurfaceCache } = await import("~/lib/terminal-surface-cache");
const { TerminalPanel } = await import("../TerminalPanel");

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

function renderPanel(sess: Session = session) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <TerminalPanel
          active={{
            sessionId: SESSION_ID,
            ptyId: null,
            startCommand: "claude",
            dangerouslySkipPermissions: false,
            coreId: "core1",
            session: sess,
          }}
          onClose={vi.fn()}
          onHide={vi.fn()}
          onPtyReady={vi.fn()}
          bell={<button aria-label="Notifications" />}
        />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = noop;
  vi.stubGlobal("ResizeObserver", class { observe = noop; disconnect = noop; unobserve = noop; });
  stubPhone();
  dataHandlers.length = 0;
  terms.length = 0;
  state.session = session;
});
afterEach(() => {
  cleanup();
  terminalSurfaceCache.destroy(SESSION_ID);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("phone: sticky Ctrl survives Back and reopen", () => {
  it("Ctrl armed on the reopened key row applies to the next typed character", async () => {
    const first = renderPanel();
    await waitFor(() => expect(dataHandlers).toHaveLength(1));
    // Back: the pane unmounts, the surface is parked with its handler still wired.
    first.unmount();
    renderPanel();
    // Reopen reattaches the surface; input is not wired a second time.
    expect(dataHandlers).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    expect(screen.getByRole("button", { name: "Ctrl" }).getAttribute("aria-pressed")).toBe("true");
    ptyWrite.mockClear();
    act(() => dataHandlers[0]!("c"));
    expect(ptyWrite).toHaveBeenCalledWith("pty1", "\x03");
    expect(screen.getByRole("button", { name: "Ctrl" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("key-row arrows send the application-cursor form while DECCKM is on", async () => {
    renderPanel();
    await waitFor(() => expect(dataHandlers).toHaveLength(1));
    terms[0]!.modes.applicationCursorKeysMode = true;
    ptyWrite.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    expect(ptyWrite).toHaveBeenCalledWith("pty1", "\x1bOA");
  });
});

describe("phone: key-row bytes feed the turn tracker (issue 386)", () => {
  const cursorFinished = { ...session, agent: "cursor-cli", status: "finished" } as unknown as Session;
  const runningPatches = () =>
    mutateSession.mock.calls.filter(([, arg]) => (arg as { status?: string }).status === "running");

  it("a recalled history entry (key-row Up) then Enter marks a finished Session running", async () => {
    state.session = cursorFinished;
    renderPanel(cursorFinished);
    await waitFor(() => expect(dataHandlers).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    await act(async () => dataHandlers[0]!("\r"));
    expect(runningPatches()).toHaveLength(1);
  });

  it("typed text cleared by key-row Esc then Enter does not mark it running", async () => {
    state.session = cursorFinished;
    renderPanel(cursorFinished);
    await waitFor(() => expect(dataHandlers).toHaveLength(1));
    await act(async () => dataHandlers[0]!("foo"));
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    await act(async () => dataHandlers[0]!("\r"));
    expect(runningPatches()).toHaveLength(0);
  });
});
