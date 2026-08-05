// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { CoreLinkDirListing } from "@actana/shared/core-link-frames";
import type { Project } from "~/db/schema";

// A Core-owned Project's path is set at create and immutable afterwards: it is
// a VM path only the Core can validate, and no project mutation op carries one
// post-create (ADR 0022). The field used to stay editable — and Browse… was
// gated on exactly the case that could not be edited — so an operator could
// pick a new folder on the Core's disk, hit Save, and have it silently
// discarded. What the dialog offers has to match what a save can carry.

const bridge = {
  isConnected: () => true,
  listFolders: vi.fn(async (): Promise<CoreLinkDirListing> => {
    throw new Error("not stubbed");
  }),
  createFolder: vi.fn(),
  listHarnessAvailability: vi.fn(async () => ({})),
  watchCore: vi.fn(() => () => {}),
  onEvent: vi.fn(() => () => {}),
};

vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => bridge }));
vi.mock("~/queries", () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock("~/lib/api", () => ({ api: { getKeybindings: async () => ({ bindings: {} }) } }));

const { ProjectDialog } = await import("../ProjectDialog");
const { KeybindingsProvider } = await import("~/lib/keybindings/store");

const CORES = [{ id: "core_a", label: "Core A" }];

function projectRow(): Project {
  return {
    id: "p1",
    name: "Control",
    path: "/srv/control",
    icon: "CT",
    iconColor: "#7ce58a",
    imagePath: null,
    groupId: null,
    pinned: false,
    pinnedOrder: null,
    launchUrl: null,
    rememberHarnessSettings: false,
    savedHarness: null,
    savedSkipPermissions: false,
    savedBareSession: false,
    defaultGridView: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderEditDialog(projectCoreId: string | null) {
  const result = render(
    <KeybindingsProvider>
      <ProjectDialog
        open
        project={projectRow()}
        groups={[]}
        cores={CORES}
        // The browsing Core is set either way — this is the case where the two
        // props disagree, and ownership is what must decide.
        initialCoreId="core_a"
        projectCoreId={projectCoreId}
        onClose={() => {}}
        onSave={async () => {}}
      />
    </KeybindingsProvider>,
  );
  await settle();
  return result;
}

const pathField = () => screen.getByLabelText(/^Working directory/i) as HTMLInputElement;
const browseButton = () => screen.queryByRole("button", { name: /browse/i });

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => cleanup());

describe("ProjectDialog — a Core-owned Project's folder is fixed", () => {
  it("disables the Working directory field", async () => {
    await renderEditDialog("core_a");

    expect(pathField().disabled).toBe(true);
    expect(pathField().value).toBe("/srv/control");
  });

  it("drops Browse…, which only ever appeared for the case that cannot change", async () => {
    await renderEditDialog("core_a");

    expect(browseButton()).toBeNull();
  });

  it("says why, rather than leaving a dead field to puzzle over", async () => {
    await renderEditDialog("core_a");

    expect(screen.getByText(/cannot be changed here/i)).toBeTruthy();
  });

  // The project rail edits Panel-owned projects while a Core is open, so
  // ownership and the browsing Core genuinely diverge. A Panel-owned row's
  // path is PATCHable and must stay editable.
  it("leaves a Panel-owned Project's path editable even with a Core open", async () => {
    await renderEditDialog(null);

    expect(pathField().disabled).toBe(false);
    expect(browseButton()).toBeTruthy();
    expect(screen.queryByText(/cannot be changed here/i)).toBeNull();
  });
});
