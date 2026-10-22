// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { StorageCoreFolderView } from "~/shared/storage-wire";

const api = {
  getStorage: vi.fn(async () => ({
    storage: { configured: false, backend: null, masterKeySet: false, masterKeyRotatedAt: null, uploadSizeLimitBytes: null },
    cores: [] as StorageCoreFolderView[],
  })),
  getAuthState: vi.fn(async () => ({ operator: { name: "Ada" } })),
  changePassword: vi.fn(async (_input: { currentPassword: string; newPassword: string }) => ({})),
  logout: vi.fn(async () => ({})),
  listAiRuntimeModels: vi.fn(async () => []),
};

vi.mock("~/lib/api", () => ({
  api,
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("~/queries", async (orig) => {
  const actual = await orig<typeof import("~/queries")>();
  return { ...actual, useSettings: () => ({ data: undefined }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { KeybindingsProvider } = await import("~/lib/keybindings/store");
const { DefaultsSettingsPage } = await import("../DefaultsSettingsPage");
const { KeybindingsSettings } = await import("../KeybindingsSettings");
const { StorageSettingsPage } = await import("../StorageSettingsPage");
const { OperatorSettingsPage } = await import("../OperatorSettingsPage");

function stubWidth(width: number) {
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
    return {
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

afterEach(() => cleanup());

describe("settings pages on phone: class hooks", () => {
  it("Defaults grid carries mc-defaults-grid and keeps its inline 220px column (desktop unchanged)", () => {
    const qc = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={qc}>
        <DefaultsSettingsPage />
      </QueryClientProvider>,
    );
    const grid = container.querySelector(".mc-defaults-grid") as HTMLElement;
    expect(grid).toBeTruthy();
    expect(grid.style.gridTemplateColumns).toBe("220px minmax(0, 1fr)");
  });

  it("a keybinding row carries mc-keybinding-row and keeps its inline 1fr auto grid", () => {
    const { container } = render(
      <KeybindingsProvider>
        <KeybindingsSettings />
      </KeybindingsProvider>,
    );
    const row = container.querySelector(".mc-keybinding-row") as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.style.gridTemplateColumns).toBe("1fr auto");
    expect(row.querySelector(".mc-keybinding-desc")).toBeTruthy();
  });

  it("Storage tablist carries mc-storage-tabs", async () => {
    await act(async () => {
      render(<StorageSettingsPage />);
    });
    expect(screen.getByRole("tablist", { name: /Storage backend/i }).classList.contains("mc-storage-tabs")).toBe(true);
  });

  it("Storage per-Core row carries mc-storage-core-row and keeps its desktop inline layout", async () => {
    const offlineExpired: StorageCoreFolderView = {
      coreId: "core-1",
      label: "D1 Core",
      prefix: "cores/core-1/",
      sizeBytes: 2048,
      keyExpiresAt: Date.now() - 60_000,
      state: "attached",
      offline: true,
      error: null,
    };
    api.getStorage.mockResolvedValueOnce({
      storage: { configured: false, backend: null, masterKeySet: false, masterKeyRotatedAt: null, uploadSizeLimitBytes: null },
      cores: [offlineExpired],
    });
    stubWidth(390);
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<StorageSettingsPage />));
    });
    expect(screen.getByText("offline · key expired – read-only")).toBeTruthy();
    const row = container.querySelector('[data-core-folder="core-1"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.classList.contains("mc-storage-core-row")).toBe(true);
    expect(row.style.display).toBe("flex");
    expect(row.style.alignItems).toBe("center");
    expect(row.style.justifyContent).toBe("space-between");
    expect(row.style.gap).toBe("12px");
    const right = row.lastElementChild as HTMLElement;
    expect(right.textContent).toContain("offline · key expired – read-only");
    expect(right.style.textAlign).toBe("right");
    expect(right.style.flexShrink).toBe("0");
  });

  it("Operator: at 390 both password fields and Change password are in the DOM and submit calls the API", async () => {
    stubWidth(390);
    await act(async () => {
      render(<OperatorSettingsPage />);
    });
    const current = screen.getByLabelText(/Current password/i);
    const next = screen.getByLabelText(/New password/i);
    fireEvent.change(current, { target: { value: "old-password-1" } });
    fireEvent.change(next, { target: { value: "new-password-123456" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Change password/i }));
    });
    expect(api.changePassword).toHaveBeenCalledWith({
      currentPassword: "old-password-1",
      newPassword: "new-password-123456",
    });
  });
});
