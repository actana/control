import { describe, expect, it } from "vitest";
import {
  groupActiveListSessionsForDisplay,
  groupArchivedSessionsForDisplay,
  groupSessionsByStatusForDisplay,
} from "../session-display-order";
import type { SessionStatus } from "@actana/shared/domain";

function session(input: {
  id: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}) {
  return { pinned: false, ...input };
}

describe("session-display-order", () => {
  it("sorts finished sessions by most recent update first", () => {
    const grouped = groupSessionsByStatusForDisplay([
      session({ id: "newer-created", status: "finished", createdAt: 3, updatedAt: 10 }),
      session({ id: "just-finished", status: "finished", createdAt: 1, updatedAt: 30 }),
      session({ id: "middle", status: "finished", createdAt: 2, updatedAt: 20 }),
    ]);

    expect(grouped.finished.map((t) => t.id)).toEqual([
      "just-finished",
      "middle",
      "newer-created",
    ]);
  });

  it("keeps non-finished status buckets in input order", () => {
    const grouped = groupSessionsByStatusForDisplay([
      session({ id: "first-running", status: "running", createdAt: 1, updatedAt: 10 }),
      session({ id: "second-running", status: "running", createdAt: 2, updatedAt: 30 }),
    ]);

    expect(grouped.running.map((t) => t.id)).toEqual(["first-running", "second-running"]);
  });

  it("peels pinned sessions into a top section for the Active list", () => {
    const { pinned, byStatus } = groupActiveListSessionsForDisplay([
      session({ id: "unpinned-running", status: "running", createdAt: 1, updatedAt: 10 }),
      session({
        id: "pinned-ready",
        status: "ready",
        createdAt: 2,
        updatedAt: 20,
        pinned: true,
      }),
      session({
        id: "pinned-needs",
        status: "needs-input",
        createdAt: 3,
        updatedAt: 30,
        pinned: true,
      }),
      session({ id: "unpinned-ready", status: "ready", createdAt: 4, updatedAt: 40 }),
    ]);

    expect(pinned.map((t) => t.id)).toEqual(["pinned-needs", "pinned-ready"]);
    expect(byStatus.running.map((t) => t.id)).toEqual(["unpinned-running"]);
    expect(byStatus.ready.map((t) => t.id)).toEqual(["unpinned-ready"]);
    expect(byStatus["needs-input"]).toEqual([]);
  });

  it("sorts finished pinned sessions by most recent activity within the pinned section", () => {
    const { pinned } = groupActiveListSessionsForDisplay([
      session({
        id: "older-finished",
        status: "finished",
        createdAt: 1,
        updatedAt: 10,
        pinned: true,
      }),
      session({
        id: "newer-finished",
        status: "finished",
        createdAt: 2,
        updatedAt: 40,
        pinned: true,
      }),
      session({
        id: "pinned-running",
        status: "running",
        createdAt: 3,
        updatedAt: 30,
        pinned: true,
      }),
    ]);

    expect(pinned.map((t) => t.id)).toEqual([
      "pinned-running",
      "newer-finished",
      "older-finished",
    ]);
  });

  it("folds every non-finished status into finished for the archived list", () => {
    const grouped = groupArchivedSessionsForDisplay([
      session({ id: "done", status: "finished", createdAt: 1, updatedAt: 10 }),
      session({ id: "never-started", status: "ready", createdAt: 2, updatedAt: 40 }),
      session({ id: "older-ready", status: "ready", createdAt: 3, updatedAt: 20 }),
      session({ id: "cut-off", status: "disconnected", createdAt: 4, updatedAt: 30 }),
      session({ id: "cut-short", status: "interrupted", createdAt: 5, updatedAt: 50 }),
      session({ id: "was-running", status: "running", createdAt: 6, updatedAt: 5 }),
      session({ id: "awaiting", status: "needs-input", createdAt: 7, updatedAt: 25 }),
      session({ id: "killed", status: "terminated", createdAt: 8, updatedAt: 15 }),
    ]);

    for (const status of [
      "ready",
      "running",
      "needs-input",
      "interrupted",
      "terminated",
      "disconnected",
    ] as const) {
      expect(grouped[status]).toEqual([]);
    }
    expect(grouped.finished.map((t) => t.id)).toEqual([
      "cut-short",
      "never-started",
      "cut-off",
      "awaiting",
      "older-ready",
      "killed",
      "done",
      "was-running",
    ]);
  });

  it("keeps interrupted as its own column in the active list", () => {
    const { byStatus } = groupActiveListSessionsForDisplay([
      session({ id: "cut-short", status: "interrupted", createdAt: 1, updatedAt: 10 }),
      session({ id: "live", status: "running", createdAt: 2, updatedAt: 20 }),
      session({ id: "done", status: "finished", createdAt: 3, updatedAt: 30 }),
    ]);

    expect(byStatus.interrupted.map((t) => t.id)).toEqual(["cut-short"]);
    expect(byStatus.running.map((t) => t.id)).toEqual(["live"]);
    expect(byStatus.finished.map((t) => t.id)).toEqual(["done"]);
  });
});
