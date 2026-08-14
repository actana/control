// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CoreLinkProjectSnapshot } from "@actana/sdk/core-link-frames";

// The top bar's Project control is a switcher, not a label (issue 231). A
// Project is a Core-scoped noun, so everything it shows — the name it wears and
// the Projects it opens onto — comes off the owning Core's snapshot over the
// link the tab already holds. The Panel's own `projects` table has no row for
// any of them, which is what left this listbox opening onto nothing.

const bridge = {
  isConnected: () => true,
  listProjects: vi.fn(async (_coreId: string): Promise<CoreLinkProjectSnapshot[]> => []),
  watchCore: vi.fn(() => () => {}),
  onEvent: vi.fn(() => () => {}),
};

const navigate = vi.fn();

vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => bridge }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate }) }));
// The picker's own reads are the two mocked below; everything else it pulls
// from `~/queries` is Panel-local filing this suite deliberately leaves empty,
// so a row that shows up here can only have come off the Core.
vi.mock("~/queries", () => ({
  useProjects: () => ({ data: [] }),
  useGroups: () => ({ data: [] }),
  // Read by the CardFrame the popup is drawn in, not by the picker.
  useSettings: () => ({ data: undefined }),
  queryKeys: { projects: ["projects"], groups: ["groups"] },
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("~/lib/use-events", () => ({ useServerEvents: () => {} }));
vi.mock("~/lib/active-group", async () => {
  const actual = await vi.importActual<typeof import("~/shared/ui-preferences")>(
    "~/shared/ui-preferences",
  );
  return {
    ACTIVE_GROUP_ALL: actual.ACTIVE_GROUP_ALL,
    useActiveGroup: () => ({ activeGroup: actual.ACTIVE_GROUP_ALL, setActiveGroup: vi.fn(), groups: [] }),
  };
});
// Panel-side presentation (group / card image / launch URL) is filing, not a
// project list — an empty read is the honest answer for Projects nobody filed.
vi.mock("~/lib/api", () => ({
  api: {
    getKeybindings: async () => ({ bindings: {} }),
    listProjectPresentation: async () => ({ presentation: [] }),
  },
}));

const { ProjectPicker } = await import("../ProjectPicker");
const { KeybindingsProvider } = await import("~/lib/keybindings/store");

function snapshot(over: Partial<CoreLinkProjectSnapshot> & { projectId: string; name: string }): CoreLinkProjectSnapshot {
  return {
    path: `/srv/${over.projectId}`,
    icon: "AB",
    iconColor: "#88aaff",
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

const ATLAS = snapshot({ projectId: "p_atlas", name: "atlas" });
const BOREAL = snapshot({ projectId: "p_boreal", name: "boreal" });
const CINDER = snapshot({ projectId: "p_cinder", name: "cinder" });

/** Flush the Core's project read and the effects it schedules. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPicker(projectId: string, coreId: string | null = "core_a") {
  const result = render(
    <KeybindingsProvider>
      <ProjectPicker projectId={projectId} coreId={coreId} />
    </KeybindingsProvider>,
  );
  await settle();
  return result;
}

const trigger = () => screen.queryByRole("button", { expanded: false }) ?? screen.getByRole("button");

async function openPicker() {
  fireEvent.click(trigger());
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.listProjects.mockResolvedValue([ATLAS, BOREAL, CINDER]);
  // jsdom ships no layout, so the highlight's scroll-into-view is a no-op here.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => cleanup());

describe("ProjectPicker — the top bar switches Projects on the current Core", () => {
  it("wears the current Project's name, not the word Project", async () => {
    await renderPicker("p_boreal");

    expect(screen.getByRole("button", { name: /boreal/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Project$/ })).toBeNull();
  });

  it("opens onto the Core's other Projects", async () => {
    await renderPicker("p_boreal");
    await openPicker();

    // The list is the Core's snapshot — the Panel's own `projects` table is
    // empty in this suite, so these rows can only have come over the link.
    expect(bridge.listProjects).toHaveBeenCalledWith("core_a");
    expect(screen.getByText("atlas")).toBeTruthy();
    expect(screen.getByText("cinder")).toBeTruthy();
  });

  it("navigates to the picked Project, still tagged with the owning Core", async () => {
    await renderPicker("p_boreal");
    await openPicker();

    fireEvent.click(screen.getByText("cinder"));
    await settle();

    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$id",
      params: { id: "p_cinder" },
      search: { coreId: "core_a" },
    });
  });

  it("opens onto just the one Project when the Core owns only it", async () => {
    bridge.listProjects.mockResolvedValue([ATLAS]);
    await renderPicker("p_atlas");
    expect(screen.getByRole("button", { name: /atlas/ })).toBeTruthy();

    await openPicker();

    // The popup is a list of one, not an error and not a dead "No matches."
    expect(screen.getAllByText("atlas").length).toBeGreaterThan(0);
    expect(screen.queryByText(/No matches/)).toBeNull();
  });

  it("stands down when the Core's project list cannot be read", async () => {
    bridge.listProjects.mockRejectedValue(new Error("core link down"));
    await renderPicker("p_boreal");

    // The shell below it already reports an unreadable Core, with a retry. A
    // switcher that cannot name its Project would only add a second, vaguer
    // version of the same news.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing outside a Project", async () => {
    // The root path renders no switcher because the caller renders none; this
    // is the same rule from the inside — a Project id this Core does not own
    // leaves the control with nothing to represent.
    await renderPicker("p_nowhere");

    expect(screen.queryByRole("button")).toBeNull();
  });
});
