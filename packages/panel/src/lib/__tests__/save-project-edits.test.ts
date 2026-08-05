import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateProject = vi.fn();
const updateProjectPresentation = vi.fn();

vi.mock("~/lib/api", () => ({
  api: {
    updateProject: (id: string, body: unknown) => updateProject(id, body),
    updateProjectPresentation: (id: string, coreId: string, patch: unknown) =>
      updateProjectPresentation(id, coreId, patch),
  },
}));

import { __setPanelBridgeForTests } from "~/lib/panel-bridge";
import { saveProjectEdits } from "../save-project-edits";

// What the Edit-project dialog produces for an existing project.
function dialogEdits(over: Record<string, unknown> = {}) {
  return {
    name: "Renamed",
    path: "/p",
    icon: "RE",
    iconColor: "#abcdef",
    groupId: "g1",
    imagePath: "p1.png",
    ...over,
  };
}

const CORE_PROJECT = { id: "p1", name: "Original", icon: "OR", iconColor: "#111111" };

function snapshot(over: Record<string, unknown> = {}) {
  return {
    projectId: "p1",
    name: "Original",
    path: "/p",
    icon: "OR",
    iconColor: "#111111",
    pinned: false,
    rememberHarnessSettings: false,
    savedHarness: null,
    savedSkipPermissions: false,
    savedBareSession: false,
    defaultGridView: false,
    updatedAt: 1,
    ...over,
  };
}

describe("saveProjectEdits", () => {
  let mutateProject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateProject.mockReset().mockResolvedValue({ project: null });
    updateProjectPresentation.mockReset().mockResolvedValue({ presentation: null });
    // The bridge is null while server-rendering; this suite runs in node, so
    // stand up the `window` the bridge lookup gates on.
    vi.stubGlobal("window", {});
    mutateProject = vi.fn().mockResolvedValue(snapshot());
    __setPanelBridgeForTests({ mutateProject } as never);
  });

  afterEach(() => {
    __setPanelBridgeForTests(null);
    vi.unstubAllGlobals();
  });

  it("keeps a Panel-owned project on its single PATCH", async () => {
    await saveProjectEdits(null, { id: "p1", name: "Original" }, dialogEdits());

    expect(updateProject).toHaveBeenCalledWith("p1", dialogEdits());
    expect(mutateProject).not.toHaveBeenCalled();
    expect(updateProjectPresentation).not.toHaveBeenCalled();
  });

  // The bug in issue 98: the rename crossed the core-link and everything else
  // PATCHed a Panel row that does not exist for a Core-owned project, so the
  // save 404'd with the name already changed.
  it("never PATCHes the Panel for a Core-owned project", async () => {
    await saveProjectEdits("core-a", CORE_PROJECT, dialogEdits());

    expect(updateProject).not.toHaveBeenCalled();
  });

  it("sends the name as a rename and the icons as an appearance op", async () => {
    await saveProjectEdits("core-a", CORE_PROJECT, dialogEdits());

    expect(mutateProject).toHaveBeenNthCalledWith(1, "core-a", {
      op: "rename",
      projectId: "p1",
      name: "Renamed",
    });
    expect(mutateProject).toHaveBeenNthCalledWith(2, "core-a", {
      op: "appearance",
      projectId: "p1",
      icon: "RE",
      iconColor: "#abcdef",
    });
  });

  it("files group and image on the Core project's presentation row", async () => {
    await saveProjectEdits("core-a", CORE_PROJECT, dialogEdits());

    expect(updateProjectPresentation).toHaveBeenCalledWith("p1", "core-a", {
      groupId: "g1",
      imagePath: "p1.png",
    });
  });

  it("clearing the group travels as an explicit null, not as an omission", async () => {
    await saveProjectEdits("core-a", CORE_PROJECT, dialogEdits({ groupId: null }));

    expect(updateProjectPresentation).toHaveBeenCalledWith("p1", "core-a", {
      groupId: null,
      imagePath: "p1.png",
    });
  });

  it("sends nothing the operator did not change", async () => {
    await saveProjectEdits(
      "core-a",
      CORE_PROJECT,
      { name: "Original", path: "/p", icon: "OR", iconColor: "#111111" },
    );

    expect(mutateProject).not.toHaveBeenCalled();
    expect(updateProjectPresentation).not.toHaveBeenCalled();
  });

  it("sends only the icon field that changed", async () => {
    await saveProjectEdits("core-a", CORE_PROJECT, dialogEdits({ name: "Original", icon: "OR" }));

    expect(mutateProject).toHaveBeenCalledTimes(1);
    expect(mutateProject).toHaveBeenCalledWith("core-a", {
      op: "appearance",
      projectId: "p1",
      iconColor: "#abcdef",
    });
  });

  // Both icon columns are NOT NULL on the Core, so a blank box is not an erase.
  it("treats a blank icon as unchanged", async () => {
    await saveProjectEdits("core-a", CORE_PROJECT, dialogEdits({ name: "Original", icon: "  ", iconColor: "" }));

    expect(mutateProject).not.toHaveBeenCalled();
  });

  it("throws when the Core rejects the rename, instead of PATCHing on regardless", async () => {
    mutateProject.mockRejectedValueOnce(new Error("core said no"));

    await expect(saveProjectEdits("core-a", CORE_PROJECT, dialogEdits())).rejects.toThrow(
      "core said no",
    );
    expect(updateProjectPresentation).not.toHaveBeenCalled();
  });
});
