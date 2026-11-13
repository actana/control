// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Settings › General › Auto-retry (#958): the kill switch, the attempts ceiling 1-3 and the Cores whose breaker tripped.

type View = { enabled: boolean; maxAttemptsCeiling: number; pausedCores: { coreId: string; label: string }[] };
let view: View;
const api = vi.hoisted(() => ({
  getAutoRetrySettings: vi.fn(),
  updateAutoRetrySettings: vi.fn(),
  resumeAutoRetryCore: vi.fn(),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { AutoRetrySettingsSection } = await import("../AutoRetrySettingsSection");

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AutoRetrySettingsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  view = { enabled: true, maxAttemptsCeiling: 3, pausedCores: [] };
  for (const fn of Object.values(api)) fn.mockReset();
  api.getAutoRetrySettings.mockImplementation(async () => view);
  api.updateAutoRetrySettings.mockImplementation(async (patch: Partial<View>) => (view = { ...view, ...patch }));
  api.resumeAutoRetryCore.mockImplementation(async (id: string) => (view = { ...view, pausedCores: view.pausedCores.filter((c) => c.coreId !== id) }));
});
afterEach(cleanup);

describe("Auto-retry settings", () => {
  it("shows the switch on and the ceiling at 3 by default", async () => {
    mount();
    const sw = await screen.findByRole("switch", { name: /auto-retry/i });
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    expect(sw.getAttribute("aria-checked")).toBe("true");
    const ceiling = screen.getByRole("radiogroup", { name: "Maximum attempts" });
    expect(within(ceiling).getByRole("radio", { name: "3" }).getAttribute("aria-checked")).toBe("true");
    expect(within(ceiling).getAllByRole("radio").map((r) => r.textContent)).toEqual(["1", "2", "3"]);
  });

  it("the switch sends enabled", async () => {
    mount();
    await waitFor(() => expect((screen.getByRole("switch", { name: /auto-retry/i }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch", { name: /auto-retry/i }));
    await waitFor(() => expect(api.updateAutoRetrySettings).toHaveBeenCalledWith({ enabled: false }));
    await waitFor(() => expect(screen.getByRole("switch", { name: /auto-retry/i }).getAttribute("aria-checked")).toBe("false"));
  });

  it("choosing a ceiling sends it", async () => {
    mount();
    const ceiling = await screen.findByRole("radiogroup", { name: "Maximum attempts" });
    fireEvent.click(within(ceiling).getByRole("radio", { name: "2" }));
    await waitFor(() => expect(api.updateAutoRetrySettings).toHaveBeenCalledWith({ maxAttemptsCeiling: 2 }));
  });

  it("says no Core is paused when none is", async () => {
    mount();
    expect(await screen.findByText(/No Core is paused/)).toBeTruthy();
  });

  it("lists a paused Core with a Resume button that resumes it", async () => {
    view.pausedCores = [{ coreId: "c1", label: "workstation-berlin" }];
    mount();
    expect(await screen.findByText("workstation-berlin")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
    await waitFor(() => expect(api.resumeAutoRetryCore).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.queryByText("workstation-berlin")).toBeNull());
  });

  it("shows an error when saving fails", async () => {
    api.updateAutoRetrySettings.mockRejectedValueOnce(new Error("boom"));
    mount();
    await waitFor(() => expect((screen.getByRole("switch", { name: /auto-retry/i }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch", { name: /auto-retry/i }));
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });
});
