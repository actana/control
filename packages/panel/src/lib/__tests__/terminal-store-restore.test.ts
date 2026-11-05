// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "~/db/schema";
import { loadGridView, loadPersistedSessions } from "../terminal-store";

// #895: a reload must not reopen (and so resume) more than the grid's cap, nor
// the finished Sessions a grid opened.

const session = (id: string, status: string, updatedAt = 1, pinned = false) =>
  ({
    id,
    title: id,
    titleManuallySet: false,
    icon: null,
    agent: "claude-code",
    status,
    branch: "main",
    preview: "",
    lines: 0,
    archived: false,
    pinned,
    claudeSessionId: null,
    claudeSkipPermissions: false,
    claudeBareSession: false,
    createdAt: 1,
    updatedAt,
  }) as Session;

const entry = (s: Session, openedByGrid = true, coreId = "a") => ({
  sessionId: s.id,
  startCommand: "claude",
  dangerouslySkipPermissions: false,
  session: s,
  coreId,
  ...(openedByGrid ? { openedByGrid: true } : {}),
});

const store = (entries: unknown[], gridView = "1") => {
  window.localStorage.setItem("mc.terminalOpenSessions", JSON.stringify(entries));
  window.localStorage.setItem("mc.gridView", gridView);
};

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("restoring mc.terminalOpenSessions (#895)", () => {
  it("restores at most the cap per Core, keeping running Sessions", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => entry(session(`idle-${i}`, "ready", i))),
      entry(session("run", "running", 0)),
    ];
    store(rows);
    const restored = loadPersistedSessions();
    expect(restored).toHaveLength(8);
    expect(restored.some((r) => r.sessionId === "run")).toBe(true);
  });

  it("drops finished Sessions that the grid opened, keeps ones opened by hand", () => {
    store([
      entry(session("grid-done", "finished")),
      entry(session("hand-done", "finished"), false),
      entry(session("live", "running")),
    ]);
    expect(loadPersistedSessions().map((r) => r.sessionId).sort()).toEqual(["hand-done", "live"]);
  });

  it("applies the cap to each Core on its own", () => {
    store([
      ...Array.from({ length: 8 }, (_, i) => entry(session(`a${i}`, "ready"), true, "a")),
      ...Array.from({ length: 8 }, (_, i) => entry(session(`b${i}`, "ready"), true, "b")),
    ]);
    expect(loadPersistedSessions()).toHaveLength(16);
  });
});

describe("restoring mc.gridView (#895)", () => {
  it("is not restored when more Sessions than the cap would open", () => {
    store(Array.from({ length: 9 }, (_, i) => entry(session(`s${i}`, "ready"))));
    expect(loadGridView()).toBe(false);
  });

  it("is restored when the open Sessions fit the cap", () => {
    store(Array.from({ length: 8 }, (_, i) => entry(session(`s${i}`, "ready"))));
    expect(loadGridView()).toBe(true);
  });

  it("stays off after the over-cap reload has re-persisted a smaller set", () => {
    store(Array.from({ length: 9 }, (_, i) => entry(session(`s${i}`, "ready"))));
    loadGridView();
    expect(window.localStorage.getItem("mc.gridView")).toBe("0");
  });
});
