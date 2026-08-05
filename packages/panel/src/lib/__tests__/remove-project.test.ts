import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const deleteProject = vi.fn();
const deleteProjectPresentation = vi.fn();
const prunedNotifications: unknown[] = [];

vi.mock("~/lib/api", () => ({
  api: {
    deleteProject: (id: string) => {
      calls.push(`http-delete:${id}`);
      return deleteProject(id);
    },
    deleteProjectPresentation: (id: string) => {
      calls.push(`presentation-delete:${id}`);
      return deleteProjectPresentation(id);
    },
  },
}));

vi.mock("~/lib/session-notification-store", () => ({
  pruneStoredSessionFinishNotifications: (scope: unknown) => {
    calls.push("prune-notifications");
    prunedNotifications.push(scope);
  },
}));

import { __setPanelBridgeForTests } from "~/lib/panel-bridge";
import { removeProject } from "../remove-project";

describe("removeProject", () => {
  let mutateProject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls.length = 0;
    prunedNotifications.length = 0;
    deleteProject.mockReset().mockResolvedValue(undefined);
    deleteProjectPresentation.mockReset().mockResolvedValue(undefined);
    // The bridge is null while server-rendering; this suite runs in node, so
    // stand up the `window` the bridge lookup gates on.
    vi.stubGlobal("window", {});
    mutateProject = vi.fn().mockResolvedValue(null);
    __setPanelBridgeForTests({ mutateProject } as never);
  });

  afterEach(() => {
    __setPanelBridgeForTests(null);
    vi.unstubAllGlobals();
  });

  it("deletes a Panel-owned project over the HTTP endpoint", async () => {
    await removeProject(null, "p1");

    expect(calls).toEqual(["http-delete:p1"]);
    expect(mutateProject).not.toHaveBeenCalled();
  });

  // Issue 97: both remove paths called the Panel's own DELETE, which 404s for a
  // project whose row lives on a Core — the removal was simply impossible.
  it("archives a Core-owned project on its Core, never over the Panel's DELETE", async () => {
    await removeProject("core-a", "p1");

    expect(mutateProject).toHaveBeenCalledWith("core-a", { op: "archive", projectId: "p1" });
    expect(calls).not.toContain("http-delete:p1");
  });

  it("sweeps the Panel's own leftovers the Core's delete knows nothing about", async () => {
    await removeProject("core-a", "p1");

    expect(calls).toEqual(["prune-notifications", "presentation-delete:p1"]);
    expect(prunedNotifications).toEqual([{ type: "project", projectId: "p1" }]);
  });

  // The project is already gone on its Core by this point. Failing here would
  // read to the operator as "the removal didn't work", and the lazy prune on
  // the next project read collects the row anyway.
  it("does not fail a completed removal when the filing sweep fails", async () => {
    deleteProjectPresentation.mockRejectedValueOnce(new Error("panel db locked"));

    await expect(removeProject("core-a", "p1")).resolves.toBeUndefined();
    expect(prunedNotifications).toHaveLength(1);
  });

  it("propagates a Core-side failure so the caller can surface it", async () => {
    mutateProject.mockRejectedValueOnce(new Error("core unreachable"));

    await expect(removeProject("core-a", "p1")).rejects.toThrow("core unreachable");
    // Nothing was removed, so nothing local should have been forgotten either.
    expect(calls).toEqual([]);
  });
});
