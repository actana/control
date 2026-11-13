import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPACITY_MAX_PAGES, CAPACITY_TTL_MS, noteCoreCap, readCoreCapacity, resetCoreCapacityForTests } from "../core-capacity";

/** A Core's live PTYs against its limit (#962), against a fake link: no database, no Core. */

const row = (ptyId: string | null, agent = "claude-code") => ({ sessionId: Math.random().toString(), ptyId, agent });
const linkOf = (pages: unknown[][]) => {
  let n = 0;
  const request = vi.fn(async () => ({
    type: "sessionsListResult",
    sessions: pages[n] ?? [],
    total: pages.flat().length,
    nextCursor: ++n < pages.length ? `c${n}` : null,
  }));
  return { request };
};

beforeEach(() => resetCoreCapacityForTests());

describe("readCoreCapacity", () => {
  it("counts the harness Sessions that have a PTY, against the Core's default limit of 8", async () => {
    const link = linkOf([[row("p1"), row("p2"), row(null), row("p3", "")]]);
    expect(await readCoreCapacity("c1", () => link as never)).toEqual({ liveSessions: 2, maxSessions: 8 });
  });

  it("follows the cursor across pages, up to a bound", async () => {
    const link = linkOf([[row("a")], [row("b")], [row("c")]]);
    expect((await readCoreCapacity("c1", () => link as never)).liveSessions).toBe(3);
    resetCoreCapacityForTests();
    const long = linkOf(Array.from({ length: CAPACITY_MAX_PAGES + 3 }, () => [row("x")]));
    expect((await readCoreCapacity("c1", () => long as never)).liveSessions).toBe(CAPACITY_MAX_PAGES);
  });

  it("uses the limit the Core last refused a start at", async () => {
    noteCoreCap("c1", 4);
    expect((await readCoreCapacity("c1", () => linkOf([[row("a")]]) as never)).maxSessions).toBe(4);
  });

  it("is null (unknown), never thrown, when there is no link, the Core errors or answers something else", async () => {
    expect((await readCoreCapacity("c1", () => null)).liveSessions).toBeNull();
    resetCoreCapacityForTests();
    const bad = { request: async () => { throw new Error("down"); } };
    expect((await readCoreCapacity("c1", () => bad as never)).liveSessions).toBeNull();
    resetCoreCapacityForTests();
    const other = { request: async () => ({ type: "error", message: "does not take" }) };
    expect((await readCoreCapacity("c1", () => other as never)).liveSessions).toBeNull();
  });

  it("is unknown, not 0, for a Core that answers an empty list with no total (it cannot read its Sessions)", async () => {
    const blind = { request: async () => ({ type: "sessionsListResult", sessions: [], nextCursor: null }) };
    expect((await readCoreCapacity("c1", () => blind as never)).liveSessions).toBeNull();
    resetCoreCapacityForTests();
    const idle = { request: async () => ({ type: "sessionsListResult", sessions: [], nextCursor: null, total: 0 }) };
    expect((await readCoreCapacity("c1", () => idle as never)).liveSessions).toBe(0);
  });

  it("asks a Core once per TTL, then again", async () => {
    const link = linkOf([[row("a")]]);
    let t = 1000;
    const now = () => t;
    await readCoreCapacity("c1", () => link as never, now);
    await readCoreCapacity("c1", () => link as never, now);
    expect(link.request).toHaveBeenCalledTimes(1);
    t += CAPACITY_TTL_MS;
    await readCoreCapacity("c1", () => link as never, now);
    expect(link.request).toHaveBeenCalledTimes(2);
  });
});
