// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UpdateCheck } from "@actana/shared/actana-update-check";
import { UpdateBanner } from "../UpdateBanner";
import { queryKeys } from "~/queries";
import { PANEL_UPDATE_COMMAND } from "~/shared/cores";

// An alert and nothing else: what is available, what this Panel is on, and the
// command its operator runs on the host. No button applies it, and dismissing
// one release does not hide the next.

function renderBanner(check: UpdateCheck | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (check) client.setQueryData(queryKeys.updateCheck, check);
  return render(
    <QueryClientProvider client={client}>
      <UpdateBanner />
    </QueryClientProvider>,
  );
}

const available: UpdateCheck = { current: "0.1.0", latest: "0.2.0", updateAvailable: true };

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("UpdateBanner", () => {
  it("names the available release, the running one, and the remedy", () => {
    renderBanner(available);
    const text = document.body.textContent ?? "";
    expect(text).toContain("0.2.0");
    expect(text).toContain("0.1.0");
    expect(text).toContain(PANEL_UPDATE_COMMAND);
  });

  // The whole design constraint: the Panel does not rewrite itself (ADR 0010).
  it("offers no way to apply the update", () => {
    renderBanner(available);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("aria-label")).toBe("Dismiss banner");
  });

  it("shows nothing while the check has not answered", () => {
    renderBanner(undefined);
    expect(document.body.textContent).toBe("");
  });

  it("shows nothing when this Panel is already on the newest release", () => {
    renderBanner({ current: "0.2.0", latest: "0.2.0", updateAvailable: false });
    expect(document.body.textContent).toBe("");
  });

  // The live path today — nothing published, nothing to say.
  it("shows nothing when the channel could not be read", () => {
    renderBanner({ current: "0.1.0", latest: null, updateAvailable: false });
    expect(document.body.textContent).toBe("");
  });

  it("stays dismissed for the release that was dismissed", () => {
    renderBanner(available);
    fireEvent.click(screen.getByLabelText("Dismiss banner"));
    expect(document.body.textContent).toBe("");

    cleanup();
    renderBanner(available);
    expect(document.body.textContent).toBe("");
  });

  it("comes back for the next release", () => {
    renderBanner(available);
    fireEvent.click(screen.getByLabelText("Dismiss banner"));
    cleanup();

    renderBanner({ current: "0.1.0", latest: "0.3.0", updateAvailable: true });
    expect(document.body.textContent).toContain("0.3.0");
  });
});
