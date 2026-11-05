// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { Session } from "~/db/schema";

// #895: the grid draws at most the tile cap and says how many more are open.

const session = (id: string, status: string, updatedAt: number): Session =>
  ({
    id,
    title: id,
    agent: "claude-code",
    status,
    archived: false,
    pinned: false,
    icon: null,
    createdAt: 0,
    updatedAt,
  }) as unknown as Session;

let open: Array<{ sessionId: string; coreId: string; session: Session }> = [];
const noop = () => {};

vi.mock("~/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/queries")>()),
  useSessions: () => ({ data: open.map((o) => o.session) }),
  useSettings: () => ({ data: undefined }),
}));
vi.mock("~/lib/user-terminal-store", () => ({ useUserTerminals: () => ({ panelOpen: false }) }));
vi.mock("../TerminalPane", () => ({
  TerminalPane: ({ session: s }: { session: Session }) => <div data-testid="pane" data-id={s.id} />,
}));
vi.mock("~/lib/terminal-store", () => ({
  useTerminals: () => ({
    sessions: open,
    close: noop,
    setPtyId: noop,
    gridFocusRequest: null,
    takeCloneInsertAfter: () => null,
    takeNewRowRequest: () => false,
    takeSessionIdRenames: () => [],
    noteGridFocusedSession: noop,
    activeSessionIdFor: () => null,
    consumeGridFocusRequest: () => false,
  }),
}));

const { SessionGrid } = await import("../SessionGrid");

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <KeybindingsProvider>
        <SessionGrid coreId="a" />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe = noop; disconnect = noop; unobserve = noop; });
  Element.prototype.scrollIntoView = noop;
  Element.prototype.getAnimations = () => [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("SessionGrid tile cap (#895)", () => {
  it("draws at most the cap and shows a +N more chip, keeping running Sessions", async () => {
    open = [
      ...Array.from({ length: 10 }, (_, i) => ({
        sessionId: `done-${i}`,
        coreId: "a",
        session: session(`done-${i}`, "finished", i),
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        sessionId: `run-${i}`,
        coreId: "a",
        session: session(`run-${i}`, "running", i),
      })),
    ];
    await act(async () => {
      mount();
    });
    await waitFor(() => expect(document.querySelectorAll("[data-grid-cell]")).toHaveLength(8));
    const cells = Array.from(document.querySelectorAll("[data-grid-cell]"));
    expect(cells).toHaveLength(8);
    const ids = cells.map((c) => c.getAttribute("data-session-id"));
    for (const id of ["run-0", "run-1", "run-2"]) expect(ids).toContain(id);
    expect(screen.getByText("+5 more")).toBeTruthy();
  });

  it("shows no chip when everything fits", async () => {
    open = Array.from({ length: 3 }, (_, i) => ({
      sessionId: `s${i}`,
      coreId: "a",
      session: session(`s${i}`, "running", i),
    }));
    await act(async () => {
      mount();
    });
    expect(document.querySelectorAll("[data-grid-cell]")).toHaveLength(3);
    expect(screen.queryByText(/more$/)).toBeNull();
  });
});
