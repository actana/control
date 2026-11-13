// @vitest-environment jsdom
//
// #895: a Session with no live PTY that is not running must not be resumed just
// because its tile mounted. The pane attaches read-only and offers Resume; only
// that click sends a `spawn` frame. Edges mocked: xterm, the PTY link, the stores.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { Session } from "~/db/schema";
import type { PendingQuestion } from "~/shared/harness-questions";

const SESSION_ID = "s1";
const baseSession = {
  id: SESSION_ID,
  title: "Implement #558: pairing form",
  agent: "claude-code",
  status: "finished",
  pinned: false,
  archived: false,
  icon: null,
  createdAt: 0,
  updatedAt: Date.now() - 2 * 60_000,
} as unknown as Session;
const session = baseSession;

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
const spawn = vi.fn(async (..._args: unknown[]) => ({ ptyId: "pty1", hooksReportTurnStart: false }));
const ptyWrite = vi.fn(async () => true);
const ptyBridge = {
  spawn: spawn,
  submitPrompt: async () => true,
  write: ptyWrite,
  resize: async () => true,
  kill: async () => true,
  replay: async () => ({ data: "", nextSeq: 0 }),
  subscribe: async () => {},
  unsubscribe: async () => {},
  findBySession: async (): Promise<{ ptyId: string | null }> => ({ ptyId: null }),
  onData: () => noop,
  onExit: () => noop,
  onReconnect: () => noop,
  isLinkUp: () => true,
  onLinkChange: () => noop,
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
const { TerminalPane } = await import("../TerminalPane");

function renderPane(sess: Session) {
  state.session = sess;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <TerminalPane
          session={sess}
          isLast
          descriptor={{
            sessionId: SESSION_ID,
            ptyId: null,
            startCommand: "claude --resume abc",
            dangerouslySkipPermissions: false,
            coreId: "core1",
          }}
          onPtyReady={vi.fn()}
        />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = noop;
  vi.stubGlobal("ResizeObserver", class { observe = noop; disconnect = noop; unobserve = noop; });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, addEventListener: noop, removeEventListener: noop,
    addListener: noop, removeListener: noop, dispatchEvent: () => false, onchange: null,
  }));
  terms.length = 0;
  dataHandlers.length = 0;
});
afterEach(() => {
  cleanup();
  terminalSurfaceCache.destroy(SESSION_ID);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TerminalPane never resumes a Session to draw its tile (#895)", () => {
  it("a finished Session without a live PTY sends no spawn frame until Resume is clicked", async () => {
    renderPane({ ...baseSession, status: "finished" } as Session);
    const resume = await screen.findByRole("button", { name: "Resume" });
    expect(spawn).not.toHaveBeenCalled();
    fireEvent.click(resume);
    await waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(spawn.mock.calls[0]![0]).toMatchObject({ sessionId: SESSION_ID, command: "claude --resume abc" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resume" })).toBeNull());
  });

  it("a running Session without a live PTY still starts on its own", async () => {
    renderPane({ ...baseSession, status: "running" } as Session);
    await waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("a finished Session whose PTY is still alive attaches without a Resume button", async () => {
    const find = vi.spyOn(ptyBridge, "findBySession").mockResolvedValue({ ptyId: "live-pty" });
    vi.spyOn(ptyBridge, "replay").mockResolvedValue({ data: "hi", nextSeq: 2 });
    renderPane({ ...baseSession, status: "finished" } as Session);
    await waitFor(() => expect(find).toHaveBeenCalled());
    expect(spawn).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });
});
