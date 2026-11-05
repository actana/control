import { describe, expect, it } from "vitest";
import {
  MAX_GRID_TILES,
  capGridTiles,
  gridTileCap,
  isSettledSessionStatus,
  pickDefaultGridSessions,
} from "../grid-layout-prefs";

type Row = {
  id: string;
  status: string;
  pinned: boolean;
  updatedAt: number;
  archived?: boolean;
};
const row = (id: string, status: string, updatedAt: number, pinned = false): Row => ({
  id,
  status,
  pinned,
  updatedAt,
});

describe("gridTileCap (#895)", () => {
  it("is 8 at 1024px and up, 4 from 768 to 1023px", () => {
    expect(MAX_GRID_TILES.desktop).toBe(8);
    expect(MAX_GRID_TILES.tablet).toBe(4);
    expect(gridTileCap(1024)).toBe(8);
    expect(gridTileCap(2560)).toBe(8);
    expect(gridTileCap(1023)).toBe(4);
    expect(gridTileCap(768)).toBe(4);
  });
});

describe("pickDefaultGridSessions (#895)", () => {
  it("never picks finished or archived Sessions", () => {
    const rows = [
      row("done", "finished", 9),
      row("dead", "terminated", 9),
      { ...row("arch", "running", 9), archived: true },
      row("ready", "ready", 1),
    ];
    expect(pickDefaultGridSessions(rows, 8).map((r) => r.id)).toEqual(["ready"]);
  });

  it("orders running or needing input first, then pinned, then most recently updated", () => {
    const rows = [
      row("recent", "ready", 100),
      row("pinned-old", "ready", 1, true),
      row("run-old", "running", 2),
      row("input", "needs-input", 3),
      row("older", "ready", 50),
    ];
    expect(pickDefaultGridSessions(rows, 8).map((r) => r.id)).toEqual([
      "input",
      "run-old",
      "pinned-old",
      "recent",
      "older",
    ]);
  });

  it("returns at most the cap out of 200 Sessions, running ones first", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      row(`s${i}`, i % 50 === 0 ? "running" : "finished", i),
    );
    rows.push(...Array.from({ length: 20 }, (_, i) => row(`r${i}`, "ready", 1000 + i)));
    const picked = pickDefaultGridSessions(rows, 8);
    expect(picked).toHaveLength(8);
    expect(picked.slice(0, 4).every((r) => r.status === "running")).toBe(true);
  });
});

describe("capGridTiles (#895)", () => {
  it("keeps everything at or under the cap, in order", () => {
    const rows = [row("a", "ready", 1), row("b", "ready", 2)];
    expect(capGridTiles(rows, 8)).toEqual(rows);
  });

  it("keeps the top-ranked cap Sessions over the cap, preserving the original order", () => {
    const rows = [
      row("a", "finished", 1),
      row("b", "running", 2),
      row("c", "finished", 3),
      row("d", "needs-input", 4),
    ];
    expect(capGridTiles(rows, 2).map((r) => r.id)).toEqual(["b", "d"]);
  });
});

describe("capGridTiles with explicitly shown Sessions (#895)", () => {
  it("keeps a Session the operator picked even when it ranks last", () => {
    const rows = [
      row("a", "running", 4),
      row("b", "running", 3),
      row("c", "running", 2),
      row("picked", "finished", 1),
    ];
    expect(
      capGridTiles(rows, 3, undefined, (r) => r.id === "picked").map((r) => r.id),
    ).toEqual(["a", "b", "picked"]);
  });
});

describe("isSettledSessionStatus (#895)", () => {
  it("treats only ready, running and needs-input as live", () => {
    expect(isSettledSessionStatus("finished")).toBe(true);
    expect(isSettledSessionStatus("terminated")).toBe(true);
    expect(isSettledSessionStatus("interrupted")).toBe(true);
    expect(isSettledSessionStatus("disconnected")).toBe(true);
    expect(isSettledSessionStatus("ready")).toBe(false);
    expect(isSettledSessionStatus("running")).toBe(false);
    expect(isSettledSessionStatus("needs-input")).toBe(false);
  });
});
