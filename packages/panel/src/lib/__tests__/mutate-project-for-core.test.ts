import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const updateProject = vi.fn();
const deleteProject = vi.fn();

vi.mock("~/lib/api", () => ({
  api: {
    updateProject: (id: string, body: unknown) => {
      calls.push(`update:${id}`);
      return updateProject(id, body);
    },
    deleteProject: (id: string) => {
      calls.push(`delete:${id}`);
      return deleteProject(id);
    },
  },
}));

import { __setPanelBridgeForTests } from "~/lib/panel-bridge";
import { mutateProjectForCore } from "../mutate-project-for-core";

function panelProject(over: Record<string, unknown> = {}) {
  return {
    project: {
      id: "p1",
      name: "Control",
      path: "/srv/control",
      icon: "CT",
      iconColor: "#7ce58a",
      pinned: false,
      rememberHarnessSettings: false,
      savedHarness: null,
      savedSkipPermissions: false,
      savedBareSession: false,
      defaultGridView: false,
      updatedAt: 42,
      ...over,
    },
  };
}

describe("mutateProjectForCore", () => {
  let mutateProject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls.length = 0;
    updateProject.mockReset().mockResolvedValue(panelProject());
    deleteProject.mockReset().mockResolvedValue(undefined);
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

  it("sends a Core-owned mutation over the panel link, not the Panel's HTTP API", async () => {
    await mutateProjectForCore("core-a", { op: "appearance", projectId: "p1", icon: "ZZ" });

    expect(mutateProject).toHaveBeenCalledWith("core-a", {
      op: "appearance",
      projectId: "p1",
      icon: "ZZ",
    });
    expect(calls).toEqual([]);
  });

  it("patches a Panel-owned row's icons over the update endpoint", async () => {
    await mutateProjectForCore(null, {
      op: "appearance",
      projectId: "p1",
      icon: "ZZ",
      iconColor: "#abcdef",
    });

    expect(updateProject).toHaveBeenCalledWith("p1", { icon: "ZZ", iconColor: "#abcdef" });
  });

  it("drops undefined fields so a partial patch stays partial", async () => {
    await mutateProjectForCore(null, {
      op: "appearance",
      projectId: "p1",
      icon: "ZZ",
      iconColor: undefined,
    });

    expect(updateProject).toHaveBeenCalledWith("p1", { icon: "ZZ" });
  });

  // `archive` is a destructive delete at the protocol layer, and the Panel's
  // own row has no archived column — a PATCH here silently did nothing.
  it("maps a Panel-owned archive onto the delete endpoint", async () => {
    const result = await mutateProjectForCore(null, { op: "archive", projectId: "p1" });

    expect(calls).toEqual(["delete:p1"]);
    expect(result).toBeNull();
  });

  it("refuses to create a project no Core owns", async () => {
    await expect(
      mutateProjectForCore(null, { op: "create", name: "x", path: "/x" }),
    ).rejects.toThrow(/no Core owns/);
  });
});
