// @vitest-environment jsdom
//
// #832 M21/M22: the Session terminal on a phone is a full-screen view with Back,
// the status row, the key row and the harness question as a bottom sheet. The
// edges are mocked: xterm (a pre-seeded surface in the surface cache whose
// `writeToPty` is a spy), the stores, the link bridge. Desktop is asserted
// unchanged below.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
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
vi.mock("~/lib/user-terminal-store", () => ({ useUserTerminals: () => ({ panelOpen: false }) }));
vi.mock("~/lib/use-hotkey", () => ({ useHotkey: noop }));
vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({}),
  getCorePtyBridge: () => null,
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
const { phoneTerminalInput } = await import("../TerminalMobileChrome");
const { useStickyCtrl } = await import("../TerminalKeyRow");

function stubMatchMedia(width: number) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) => {
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
    },
  );
}

const writeToPty = vi.fn();
const paste = vi.fn();
function seedSurface() {
  terminalSurfaceCache.set({
    id: SESSION_ID,
    el: document.createElement("div"),
    buildKey: "0 0 0",
    ptyId: "pty1",
    destroyed: false,
    controls: { focus: noop, clear: noop, setFontSize: noop, writeToPty, sendKeys: writeToPty, paste },
    fit: noop,
    teardown: noop,
  } as never);
}

const onHide = vi.fn();
const onClose = vi.fn();
function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
      <TerminalPanel
        active={{
          sessionId: SESSION_ID,
          ptyId: "pty1",
          startCommand: "claude",
          dangerouslySkipPermissions: false,
          coreId: "core1",
          session,
        }}
        onClose={onClose}
        onHide={onHide}
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
  state.session = session;
  state.question = null;
  state.writable = true;
  seedSurface();
});
afterEach(() => {
  cleanup();
  terminalSurfaceCache.destroy(SESSION_ID);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("phone: Session terminal", () => {
  beforeEach(() => stubMatchMedia(390));

  it("an open Session's terminal fills the screen with Back, title and status", () => {
    renderPanel();
    const screenEl = document.querySelector("[data-session-terminal-screen]") as HTMLElement;
    expect(screenEl).not.toBeNull();
    expect(screenEl.style.position).toBe("fixed");
    expect(screenEl.parentElement).toBe(document.body);
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByText("Implement #558: pairing form")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText(/Claude Code/i)).toBeTruthy();
    expect(screen.getByText(/2 minutes ago/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByTitle("Drag to resize")).toBeNull();
    expect(screen.queryByRole("button", { name: /Expand session panel/ })).toBeNull();
  });

  it("Back hides the terminal and keeps the Session", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the key row sends to the PTY", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    expect(writeToPty.mock.calls.map((c) => c[0])).toEqual(["\x1b", "\x1b[A"]);
  });

  it("the key row's Paste goes through the terminal's paste, not raw PTY bytes", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: vi.fn().mockResolvedValue("echo hi") } });
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    });
    expect(paste).toHaveBeenCalledWith("echo hi");
    expect(writeToPty).not.toHaveBeenCalled();
  });

  it("the key row is hidden when the Session is read-only", () => {
    state.writable = false;
    renderPanel();
    expect(screen.queryByRole("toolbar", { name: "Terminal keys" })).toBeNull();
  });

  it("more-actions menu offers the desktop actions", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Session actions for/ }));
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toContain("Rename session");
    expect(menu.textContent).toContain("Clone session");
    expect(menu.textContent).toContain("Archive session");
  });

  it("a harness question shows as a sheet and a tap answers it", async () => {
    state.session = { ...session, status: "needs-input" } as Session;
    state.question = {
      id: "q1",
      sessionId: SESSION_ID,
      createdAt: 0,
      questions: [
        {
          question: "Drop the legacy sessions_v1 table after copy?",
          header: "Migration",
          multiSelect: false,
          options: [{ label: "Yes, drop it" }, { label: "No, keep it for now" }],
        },
      ],
    };
    renderPanel();
    expect(screen.getByText("Drop the legacy sessions_v1 table after copy?")).toBeTruthy();
    // The key row yields to the sheet (M22).
    expect(screen.queryByRole("toolbar", { name: "Terminal keys" })).toBeNull();
    const first = screen.getByRole("option", { name: "1. Yes, drop it" });
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("option", { name: "2. No, keep it for now" })).toBeTruthy();
    fireEvent.click(first);
    // Answering walks the TUI menu through the PTY (the overlay's existing path).
    await waitFor(() => expect(writeToPty).toHaveBeenCalled());
  });
});

describe("phone: sticky Ctrl", () => {
  it("Ctrl from the key row applies to the next typed character", () => {
    const { result } = renderHook(() => useStickyCtrl());
    act(() => result.current.toggle());
    let out = "";
    act(() => {
      out = phoneTerminalInput("c", result.current.consume);
    });
    expect(out).toBe("\x03");
    expect(phoneTerminalInput("c", result.current.consume)).toBe("c");
  });

  it("auto-replies do not consume Ctrl", () => {
    const { result } = renderHook(() => useStickyCtrl());
    act(() => result.current.toggle());
    // Focus report and a device-attributes reply are terminal-generated.
    expect(phoneTerminalInput("\x1b[I", result.current.consume)).toBe("\x1b[I");
    expect(phoneTerminalInput("\x1b[?1;2c", result.current.consume)).toBe("\x1b[?1;2c");
    expect(result.current.armed).toBe(true);
    expect(phoneTerminalInput("d", result.current.consume)).toBe("\x04");
  });
});

describe("desktop: Session terminal panel is unchanged", () => {
  beforeEach(() => {
    stubMatchMedia(1280);
    // jsdom has no layout: give the header a real width so it stays in the full tier.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 560 });
  });
  afterEach(() => {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  });

  it("keeps the resize handle and header controls, and has no key row or Back", () => {
    renderPanel();
    expect(screen.getByTitle("Drag to resize")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide session panel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Rename session/ })).toBeTruthy();
    expect(screen.queryByRole("toolbar", { name: "Terminal keys" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(document.querySelector("[data-session-terminal-screen]")).toBeNull();
  });
});
