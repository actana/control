// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CoreLinkDirListing } from "@actana/sdk/core-link-frames";

// A Project's path is a VM path, so the folder browser is always browsing ONE
// machine's disk. Changing the Core in the create dialog changes which machine
// that is — and nothing the Operator saw or picked on the previous one may
// survive the switch.

const bridge = {
  isConnected: () => true,
  listFolders: vi.fn(async (_coreId: string, _dir: string | null): Promise<CoreLinkDirListing> => {
    throw new Error("not stubbed");
  }),
  createFolder: vi.fn(),
  listHarnessAvailability: vi.fn(async () => ({})),
  watchCore: vi.fn(() => () => {}),
  onEvent: vi.fn(() => () => {}),
};

vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => bridge }));
vi.mock("~/queries", () => ({ useSettings: () => ({ data: undefined }) }));
// The dialog only reaches the HTTP api for project images, which this suite
// never touches; the keybindings provider is the one caller that would.
vi.mock("~/lib/api", () => ({ api: { getKeybindings: async () => ({ bindings: {} }) } }));

const { ProjectDialog } = await import("../ProjectDialog");
const { KeybindingsProvider } = await import("~/lib/keybindings/store");

const CORES = [
  { id: "core_a", label: "Core A" },
  { id: "core_b", label: "Core B" },
];

function listing(over: Partial<CoreLinkDirListing> & { path: string }): CoreLinkDirListing {
  return {
    parent: null,
    home: over.path,
    roots: [],
    entries: [],
    truncated: false,
    ...over,
  };
}

// Two Cores whose disks share no folder name, no root label, and no home.
const HOME_A = listing({
  path: "/home/alpha",
  roots: [{ label: "alpha-root", path: "/" }],
  entries: [{ name: "alpha-work", childCount: 0 }],
});
const HOME_B = listing({
  path: "/home/beta",
  roots: [{ label: "beta-root", path: "/" }],
  entries: [{ name: "beta-work", childCount: 0 }],
});
// Core A, one level below its home — the seeded-path open, which is the only
// way the breadcrumb says anything more than "~".
const DEEP_A = listing({
  path: "/home/alpha/nested",
  home: "/home/alpha",
  parent: "/home/alpha",
  roots: [{ label: "alpha-root", path: "/" }],
  entries: [{ name: "alpha-work", childCount: 0 }],
});

function stubHomes() {
  bridge.listFolders.mockImplementation(async (coreId, dir) => {
    if (coreId === "core_b") return HOME_B;
    return dir === DEEP_A.path ? DEEP_A : HOME_A;
  });
}

/**
 * Flush the listing round-trip and the effects it schedules. Every load here
 * resolves on the microtask queue, so this settles deterministically — no
 * polling, and no timeout to lose under a loaded CI box.
 */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    // The browser's focus effect is deferred a macrotask past mount.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDialog(initialPath = "") {
  const result = render(
    <KeybindingsProvider>
      <ProjectDialog
        open
        project={null}
        initialPath={initialPath}
        groups={[]}
        cores={CORES}
        initialCoreId="core_a"
        onClose={() => {}}
        onSave={async () => {}}
      />
    </KeybindingsProvider>,
  );
  await settle();
  return result;
}

const nameField = () => screen.getByLabelText(/^Name \(optional\)$/i) as HTMLInputElement;
const pathField = () => screen.getByLabelText(/^Working directory/i) as HTMLInputElement;
const filterField = () => screen.getByLabelText("Filter folders") as HTMLInputElement;
const coreSelect = () => screen.getByLabelText("Core to create the project on");
const createButton = () =>
  screen.getByRole("button", { name: /create project/i }) as HTMLButtonElement;

async function switchToCoreB() {
  fireEvent.change(coreSelect(), { target: { value: "core_b" } });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  stubHomes();
  // jsdom ships no layout, so the highlight's scroll-into-view is a no-op here.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => cleanup());

describe("ProjectDialog — switching the Core re-roots the folder browser", () => {
  it("lists the newly-selected Core's home without any manual navigation", async () => {
    await renderDialog();
    expect(screen.getByText("alpha-work")).toBeTruthy();

    await switchToCoreB();

    expect(screen.getByText("beta-work")).toBeTruthy();
    expect(screen.queryByText("alpha-work")).toBeNull();
  });

  it("re-roots the breadcrumb and the root chips on the new Core", async () => {
    await renderDialog("/home/alpha/nested/thing");
    expect(screen.getByText("nested")).toBeTruthy();
    expect(screen.getByText("alpha-root")).toBeTruthy();

    await switchToCoreB();

    expect(screen.getByText("beta-root")).toBeTruthy();
    expect(screen.queryByText("nested")).toBeNull();
    expect(screen.queryByText("alpha-root")).toBeNull();
  });

  it("clears the filter box, so the new Core's listing is not silently narrowed", async () => {
    await renderDialog();
    fireEvent.change(filterField(), { target: { value: "alpha" } });
    expect(filterField().value).toBe("alpha");

    await switchToCoreB();

    expect(screen.getByText("beta-work")).toBeTruthy();
    expect(filterField().value).toBe("");
  });

  it("does not let a previous Core's late listing paint over the new Core's", async () => {
    let releaseA: (l: CoreLinkDirListing) => void = () => {};
    bridge.listFolders.mockImplementation(async (coreId) => {
      if (coreId === "core_b") return HOME_B;
      return new Promise<CoreLinkDirListing>((resolve) => {
        releaseA = resolve;
      });
    });

    await renderDialog();
    await switchToCoreB();
    expect(screen.getByText("beta-work")).toBeTruthy();

    releaseA(HOME_A);
    await settle();

    expect(screen.getByText("beta-work")).toBeTruthy();
    expect(screen.queryByText("alpha-work")).toBeNull();
  });

  it("leaves focus on the Core selector — arrowing through it must not eject", async () => {
    await renderDialog();
    const select = coreSelect();
    select.focus();

    await switchToCoreB();

    expect(screen.getByText("beta-work")).toBeTruthy();
    expect(document.activeElement).toBe(select);
  });

  it("surfaces the new Core's error rather than leaving the old listing on screen", async () => {
    bridge.listFolders.mockImplementation(async (coreId) => {
      if (coreId === "core_b") throw new Error("core_b is unreachable");
      return HOME_A;
    });

    await renderDialog();
    expect(screen.getByText("alpha-work")).toBeTruthy();

    await switchToCoreB();

    expect(screen.getByRole("alert").textContent).toContain("unreachable");
    expect(screen.queryByText("alpha-work")).toBeNull();
  });
});

describe("ProjectDialog — switching the Core drops what was picked on the old one", () => {
  /** Pick Core A's `alpha-work`, which fills the path and auto-fills the name. */
  async function pickAlphaWork() {
    fireEvent.click(screen.getByText("alpha-work"));
    await settle();
    expect(nameField().value).toBe("alpha-work");
  }

  it("clears the committed path, so nothing from Core A can be saved against Core B", async () => {
    await renderDialog();
    await pickAlphaWork();
    expect(createButton().disabled).toBe(false);

    await switchToCoreB();

    expect(screen.getByText("beta-work")).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it("does not restore the previous Core's path when the browse is cancelled", async () => {
    await renderDialog();
    await pickAlphaWork();

    await switchToCoreB();
    fireEvent.click(screen.getByRole("button", { name: /close folder browser/i }));
    await settle();

    expect(pathField().value).toBe("");
  });

  it("drops a name auto-derived from the old Core's folder", async () => {
    await renderDialog();
    await pickAlphaWork();

    await switchToCoreB();

    expect(nameField().value).toBe("");
  });

  it("keeps a name the Operator typed themselves", async () => {
    await renderDialog();
    fireEvent.change(nameField(), { target: { value: "my project" } });

    await switchToCoreB();

    expect(screen.getByText("beta-work")).toBeTruthy();
    expect(nameField().value).toBe("my project");
  });
});
