// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CoreWithDial } from "~/shared/cores";

// Renaming a registered Core from Settings → Cores (issue 19).
//
// The alias is Panel-local presentation: this page writes it to the Panel's own
// registry and nothing reaches the machine. What the page has to get right is
// that the row shows what was *stored* — the service trims, caps and falls back
// to the endpoint host, so echoing the operator's keystrokes would show a name
// the Panel does not have.

const api = {
  listCores: vi.fn(async (): Promise<{ cores: CoreWithDial[] }> => ({ cores: CORES })),
  renameCore: vi.fn(async (_id: string, _label: string): Promise<{ core: CoreWithDial }> => {
    throw new Error("not stubbed");
  }),
  removeCore: vi.fn(async () => undefined),
  addCore: vi.fn(),
  // The page mounts a ConfirmDialog, whose hotkey reaches the keybindings store.
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
};

const toasts = { success: vi.fn(), error: vi.fn() };

vi.mock("~/lib/api", () => ({ api }));
vi.mock("sonner", () => ({ toast: toasts }));

const { CoresSettingsPage } = await import("../CoresSettingsPage");
const { KeybindingsProvider } = await import("~/lib/keybindings/store");

function core(over: Partial<CoreWithDial> = {}): CoreWithDial {
  return {
    id: "core_a",
    endpoint: "wss://prod-vm-1.internal:7777",
    label: "Core A",
    lastEventId: 0,
    createdAt: 0,
    updatedAt: 0,
    dial: { coreId: "core_a", state: "connected", lastSeenAt: 1 },
    ...over,
  };
}

let CORES: CoreWithDial[] = [core()];

async function openPage(): Promise<void> {
  render(
    <KeybindingsProvider>
      <CoresSettingsPage />
    </KeybindingsProvider>,
  );
  // Let the first listCores settle before the first assertion.
  await act(async () => {});
}

function nameBox(): HTMLInputElement {
  return screen.getByLabelText(/^Name for Core /) as HTMLInputElement;
}

/** Rename through the affordance the operator uses: pencil, type, Save. */
async function renameTo(text: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Rename Core / }));
  });
  fireEvent.change(nameBox(), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  });
}

describe("renaming a Core from Settings → Cores (issue 19)", () => {
  beforeEach(() => {
    CORES = [core()];
    vi.clearAllMocks();
    api.listCores.mockImplementation(async () => ({ cores: CORES }));
    // The service is what normalizes; stand in for it by storing what it would.
    api.renameCore.mockImplementation(async (id: string, label: string) => {
      const stored = label.trim().slice(0, 120) || "prod-vm-1.internal";
      CORES = [core({ id, label: stored })];
      return { core: CORES[0]! };
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("edits the alias in place and shows the renamed row", async () => {
    await openPage();
    expect(screen.getByText("Core A")).toBeTruthy();

    await renameTo("build-box");

    expect(api.renameCore).toHaveBeenCalledWith("core_a", "build-box");
    expect(screen.getByText("build-box")).toBeTruthy();
    // Back to a read-only row: the box is gone once the write landed.
    expect(screen.queryByLabelText(/^Name for Core /)).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith('Core renamed to "build-box".');
  });

  it("shows what the service stored, not what was typed", async () => {
    await openPage();

    // Emptying the box is a legitimate gesture — it asks for the fallback.
    await renameTo("   ");

    expect(api.renameCore).toHaveBeenCalledWith("core_a", "   ");
    expect(screen.getByText("prod-vm-1.internal")).toBeTruthy();
    expect(toasts.success).toHaveBeenCalledWith('Core renamed to "prod-vm-1.internal".');
  });

  it("caps the box at the 120 the registry stores", async () => {
    await openPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Rename Core / }));
    });
    expect(nameBox().maxLength).toBe(120);
  });

  it("leaves the row alone when the operator cancels", async () => {
    await openPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Rename Core / }));
    });
    fireEvent.change(nameBox(), { target: { value: "build-box" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Cancel renaming Core / }));
    });

    expect(api.renameCore).not.toHaveBeenCalled();
    expect(screen.getByText("Core A")).toBeTruthy();
  });

  it("keeps the operator's text in front of them when the write is refused", async () => {
    await openPage();
    api.renameCore.mockRejectedValueOnce(new Error("no such Core"));

    await renameTo("build-box");

    // Still editing, still holding what was typed — a rejected rename that
    // silently dropped the text would cost the operator their edit.
    expect(nameBox().value).toBe("build-box");
    expect(toasts.error).toHaveBeenCalledWith("no such Core");
  });
});
