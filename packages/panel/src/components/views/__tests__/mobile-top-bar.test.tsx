// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("~/lib/api", () => ({
  api: { getAuthState: vi.fn(async () => ({ operator: { name: "Mehdi" } })) },
}));

const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory } =
  await import("@tanstack/react-router");
const { MobileTopBar } = await import("../MobileTopBar");
const { CoresDrawer } = await import("../CoresDrawer");

afterEach(cleanup);

describe("MobileTopBar", () => {
  it("menu · place · bell", () => {
    render(
      <MobileTopBar place={{ label: "Fleet" }} onMenu={() => {}} bell={<button aria-label="Notifications" />} />,
    );
    const bar = screen.getByRole("banner");
    const order = [
      within(bar).getByRole("button", { name: "Open Cores menu" }),
      within(bar).getByText("Fleet"),
      within(bar).getByRole("button", { name: "Notifications" }),
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("menu opens the Cores drawer", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <MobileTopBar place={{ label: "Fleet" }} onMenu={() => setOpen(true)} bell={null} />
          <CoresDrawer
            open={open}
            onClose={() => setOpen(false)}
            cores={[]}
            fleet={{ rows: [] }}
            activeCoreId={null}
            onOpenSettings={() => {}}
          />
        </>
      );
    }
    const root = createRootRoute({ component: Harness });
    const router = createRouter({
      routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/", component: () => null })]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await act(async () => {
      render(<RouterProvider router={router} />);
      await router.load();
    });
    expect(screen.queryByRole("dialog", { name: "Cores" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open Cores menu" }));
    });
    expect(screen.getByRole("dialog", { name: "Cores" })).toBeTruthy();
  });

  it("shows Core label with status dot", () => {
    const { rerender } = render(
      <MobileTopBar
        place={{ label: "workstation-berlin", coreId: "c1", online: true }}
        onMenu={() => {}}
        bell={null}
      />,
    );
    expect(screen.getByText("workstation-berlin")).toBeTruthy();
    expect(screen.getByTestId("place-status-dot").style.background).toBe("var(--status-ready)");
    rerender(
      <MobileTopBar
        place={{ label: "workstation-berlin", coreId: "c1", online: false }}
        onMenu={() => {}}
        bell={null}
      />,
    );
    expect(screen.getByTestId("place-status-dot").style.background).toBe("var(--text-faint)");
  });
});
