// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Session } from "~/db/schema";

// #960: the startup revalidation asks each Core for its pending Sessions by id,
// not for the Core's whole list.

const listSessionRows = vi.fn();

vi.mock("../panel-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../panel-bridge")>()),
  getPanelBridge: () => ({ listSessionRows }),
  getCorePtyBridge: () => null,
}));

// The restore caps each Core at the grid's tile cap (8); lift it so a pending
// set larger than one frame's page can be exercised.
vi.mock("../grid-layout-prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../grid-layout-prefs")>()),
  gridTileCap: () => 1000,
}));

const { TerminalProvider, useTerminals } = await import("../terminal-store");

const session = (id: string): Session =>
  ({
    id,
    title: id,
    titleManuallySet: false,
    icon: null,
    agent: "claude-code",
    status: "ready",
    branch: "main",
    preview: "",
    lines: 0,
    archived: false,
    pinned: false,
    claudeSessionId: null,
    claudeSkipPermissions: false,
    claudeBareSession: false,
    createdAt: 1,
    updatedAt: 1,
  }) as Session;

const entry = (id: string, coreId: string) => ({
  sessionId: id,
  startCommand: "claude",
  dangerouslySkipPermissions: false,
  session: session(id),
  coreId,
});

const snapshot = (id: string, over: Record<string, unknown> = {}) => ({
  sessionId: id,
  title: `fresh ${id}`,
  titleManuallySet: false,
  claudeSessionId: null,
  agent: "claude-code",
  status: "ready",
  pinned: false,
  archived: false,
  icon: null,
  updatedAt: 5,
  ...over,
});

let seen: Array<{ sessionId: string; title: string; pendingValidation?: boolean }> = [];
function Probe() {
  const t = useTerminals();
  seen = t.sessions.map((s) => ({ sessionId: s.sessionId, title: s.session.title, pendingValidation: s.pendingValidation }));
  return null;
}

async function mount() {
  await act(async () => {
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>,
    );
  });
}

beforeEach(() => {
  window.localStorage.clear();
  listSessionRows.mockReset();
  seen = [];
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("pending-set lookup on startup (#960)", () => {
  it("asks by id, chunked by the page cap, once per Core", async () => {
    window.localStorage.setItem(
      "mc.terminalOpenSessions",
      JSON.stringify([
        ...Array.from({ length: 150 }, (_, i) => entry(`a${i}`, "core_a")),
        entry("b0", "core_b"),
      ]),
    );
    listSessionRows.mockImplementation(async (_core: string, page: { ids: string[] }) => ({
      sessions: page.ids.map((id) => snapshot(id)),
      archivedCount: 0,
      nextCursor: null,
    }));

    await mount();

    const calls = listSessionRows.mock.calls as Array<[string, { limit: number; ids: string[]; archived: boolean }]>;
    expect(calls.every(([, page]) => Array.isArray(page.ids) && page.archived === false)).toBe(true);
    const forA = calls.filter(([core]) => core === "core_a");
    expect(forA.map(([, p]) => p.ids.length).sort((x, y) => x - y)).toEqual([50, 100]);
    expect(forA.flatMap(([, p]) => p.ids).sort()).toEqual(Array.from({ length: 150 }, (_, i) => `a${i}`).sort());
    expect(calls.filter(([core]) => core === "core_b").map(([, p]) => p.ids)).toEqual([["b0"]]);
    // Behaviour kept: rows refreshed from the Core, gate released.
    expect(seen).toHaveLength(151);
    expect(seen.every((s) => !s.pendingValidation && s.title.startsWith("fresh"))).toBe(true);
  });

  it("closes a Session the Core does not have, and keeps one it does (old Core answering all rows)", async () => {
    window.localStorage.setItem(
      "mc.terminalOpenSessions",
      JSON.stringify([entry("keep", "core_a"), entry("gone", "core_a")]),
    );
    // An old Core ignores `ids` and answers every row it has.
    listSessionRows.mockResolvedValue({
      sessions: [snapshot("keep"), snapshot("unrelated")],
      archivedCount: 0,
      nextCursor: null,
    });

    await mount();

    expect(seen.map((s) => s.sessionId)).toEqual(["keep"]);
  });

  it("keeps the snapshot and releases the gate when the Core cannot be asked", async () => {
    window.localStorage.setItem("mc.terminalOpenSessions", JSON.stringify([entry("x", "core_a")]));
    listSessionRows.mockRejectedValue(new Error("unreachable"));

    await mount();

    expect(seen).toEqual([{ sessionId: "x", title: "x", pendingValidation: undefined }]);
  });
});
