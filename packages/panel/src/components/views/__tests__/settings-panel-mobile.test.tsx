// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const pages = {
  GeneralSettingsPage: "general",
  DefaultsSettingsPage: "defaults",
  ProvidersSettingsPage: "providers",
  UsageSettingsPage: "usage",
  StorageSettingsPage: "storage",
  ApiSettingsPage: "api",
  TerminalSettingsPage: "terminal",
  InterfaceSettingsPage: "interface",
  AppearanceSettingsPage: "appearance",
  KeybindingsPage: "keybindings",
  CoresSettingsPage: "cores",
  OperatorSettingsPage: "operator",
} as const;

vi.mock("../GeneralSettingsPage", () => ({ GeneralSettingsPage: () => <div>general page</div> }));
vi.mock("../DefaultsSettingsPage", () => ({ DefaultsSettingsPage: () => <div>defaults page</div> }));
vi.mock("../ProvidersSettingsPage", () => ({ ProvidersSettingsPage: () => <div>providers page</div> }));
vi.mock("../UsageSettingsPage", () => ({ UsageSettingsPage: () => <div>usage page</div> }));
vi.mock("../StorageSettingsPage", () => ({ StorageSettingsPage: () => <div>storage page</div> }));
vi.mock("../ApiSettingsPage", () => ({ ApiSettingsPage: () => <div>api page</div> }));
vi.mock("../TerminalSettingsPage", () => ({ TerminalSettingsPage: () => <div>terminal page</div> }));
vi.mock("../InterfaceSettingsPage", () => ({ InterfaceSettingsPage: () => <div>interface page</div> }));
vi.mock("../AppearanceSettingsPage", () => ({ AppearanceSettingsPage: () => <div>appearance page</div> }));
vi.mock("../KeybindingsPage", () => ({ KeybindingsPage: () => <div>keybindings page</div> }));
vi.mock("../CoresSettingsPage", () => ({ CoresSettingsPage: () => <div>cores page</div> }));
vi.mock("../OperatorSettingsPage", () => ({ OperatorSettingsPage: () => <div>operator page</div> }));

const { SettingsPanel: RawSettingsPanel } = await import("../SettingsPanel");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { KeybindingsProvider } = await import("~/lib/keybindings/store");

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function SettingsPanel(props: React.ComponentProps<typeof RawSettingsPanel>) {
  return (
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <RawSettingsPanel {...props} />
      </KeybindingsProvider>
    </QueryClientProvider>
  );
}
const { CLOSE_SETTINGS_EVENT } = await import("~/lib/design-meta");
const { CURRENT_MC_VERSION } = await import("~/queries/mission-control-version");

const ORDER = [
  ["general", "General"],
  ["defaults", "Defaults"],
  ["providers", "Providers"],
  ["usage", "Usage"],
  ["storage", "Storage"],
  ["api", "API & integrations"],
  ["terminal", "Terminal"],
  ["interface", "Interface"],
  ["appearance", "Appearance"],
  ["keybindings", "Keybindings"],
  ["cores", "Cores"],
  ["operator", "Operator"],
] as const;

function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      media: query,
      matches: max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

function stubVisualViewport(initial: { height: number; offsetTop: number }) {
  const vv = Object.assign(new EventTarget(), initial);
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return vv;
}

const overlay = () => document.querySelector<HTMLElement>("[data-settings-overlay]")!;
const bar = () => screen.getByRole("banner");

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "visualViewport");
  vi.clearAllMocks();
});

describe("SettingsPanel on phone (390)", () => {
  beforeEach(() => stubWidth(390));

  it("phone: a generic open shows the Settings list: 12 rows in order General…Operator, no Legal or Terms", () => {
    render(<SettingsPanel onBack={() => {}} />);
    expect(overlay().getAttribute("data-view")).toBe("list");
    const rows = Array.from(document.querySelectorAll(".mc-settings-list .mc-settings-row")).map((r) =>
      r.textContent?.trim(),
    );
    expect(rows).toEqual(ORDER.map(([, label]) => label));
    expect(screen.queryByText(/legal|terms/i)).toBeNull();
  });

  it("phone: list top bar is menu · Settings · bell; the menu calls onMenu", () => {
    const onMenu = vi.fn();
    render(<SettingsPanel onBack={() => {}} onMenu={onMenu} bell={<button aria-label="Notifications" />} />);
    const h = within(bar());
    const menu = h.getByRole("button", { name: "Open Cores menu" });
    const title = bar().querySelector(".mc-settings-title-list")!;
    const bell = h.getByRole("button", { name: "Notifications" });
    expect(title.textContent).toBe("Settings");
    expect(menu.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(menu);
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it("phone: footer reads Actana Control v{CURRENT_MC_VERSION}", () => {
    render(<SettingsPanel onBack={() => {}} />);
    expect(document.querySelector(".mc-settings-version")?.textContent).toBe(`Actana Control v${CURRENT_MC_VERSION}`);
  });

  it.each(ORDER)("phone: tapping the %s row opens that page full screen with Back and the page label", async (id, label) => {
    render(<SettingsPanel onBack={() => {}} />);
    fireEvent.click(document.querySelector<HTMLElement>(".mc-settings-list")!.querySelectorAll("button")[ORDER.findIndex(([i]) => i === id)]!);
    expect(overlay().getAttribute("data-view")).toBe("page");
    const page = document.querySelector(".mc-settings-page")!;
    expect(page.getAttribute("data-settings-page")).toBe(id);
    expect(await screen.findByText(`${id} page`)).toBeTruthy();
    expect(within(bar()).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(bar().querySelector(".mc-settings-title-page")?.textContent).toBe(label);
  });

  it("phone: Back returns to the list without calling onBack", () => {
    const onBack = vi.fn();
    render(<SettingsPanel onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    fireEvent.click(within(bar()).getByRole("button", { name: "Back" }));
    expect(overlay().getAttribute("data-view")).toBe("list");
    expect(onBack).not.toHaveBeenCalled();
  });

  it("phone: an explicit initialPanel (operator from the drawer) opens that page; Back goes to the list", async () => {
    render(<SettingsPanel onBack={() => {}} initialPanel="operator" />);
    expect(overlay().getAttribute("data-view")).toBe("page");
    expect(await screen.findByText("operator page")).toBeTruthy();
    fireEvent.click(within(bar()).getByRole("button", { name: "Back" }));
    expect(overlay().getAttribute("data-view")).toBe("list");
  });

  it("phone: the stored last-visited panel highlights its row but still opens the list", () => {
    window.localStorage.setItem("mc-settings-active-panel", "usage");
    render(<SettingsPanel onBack={() => {}} />);
    expect(overlay().getAttribute("data-view")).toBe("list");
    expect(screen.getByRole("button", { name: "Usage" }).getAttribute("aria-current")).toBe("page");
  });

  it("phone: CLOSE_SETTINGS_EVENT calls onBack at once (no slide animation)", () => {
    const onBack = vi.fn();
    render(<SettingsPanel onBack={onBack} />);
    act(() => {
      window.dispatchEvent(new Event(CLOSE_SETTINGS_EVENT));
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("phone: Escape closes at once", () => {
    const onBack = vi.fn();
    render(<SettingsPanel onBack={onBack} />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onBack).toHaveBeenCalled();
  });

  it("phone: the Settings screen height follows visualViewport when the keyboard opens; body is the scroll box", () => {
    const vv = stubVisualViewport({ height: 700, offsetTop: 0 });
    render(<SettingsPanel onBack={() => {}} initialPanel="operator" />);
    expect(overlay().style.height).toBe("700px");
    act(() => {
      vv.height = 420;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(overlay().style.height).toBe("420px");
    const body = document.querySelector<HTMLElement>(".mc-settings-phone-body")!;
    expect(body.style.overflowY).toBe("auto");
    expect(overlay().style.position).toBe("fixed");
  });

  it("phone: has no slide scrim and no desktop aside", () => {
    render(<SettingsPanel onBack={() => {}} />);
    expect(document.querySelector("aside")).toBeNull();
    expect(overlay().className).toContain("mc-settings-phone");
  });
});

describe.each([1280, 900])("SettingsPanel at %ipx keeps the desktop markup", (width) => {
  beforeEach(() => stubWidth(width));

  it("renders the 240px aside with Back, the SETTINGS label and 12 nav buttons; no .mc-settings-phone; onBack only after animationend", () => {
    const onBack = vi.fn();
    render(<SettingsPanel onBack={onBack} />);
    expect(document.querySelector(".mc-settings-phone")).toBeNull();
    const aside = document.querySelector("aside")!;
    expect((aside.parentElement as HTMLElement).style.width).toBe("240px");
    expect(within(aside).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(within(aside).getByText("Settings")).toBeTruthy();
    expect(aside.querySelectorAll("nav button")).toHaveLength(12);
    expect(overlay().getAttribute("data-view")).toBeNull();

    fireEvent.click(within(aside).getByRole("button", { name: "Back" }));
    expect(onBack).not.toHaveBeenCalled();
    // jsdom has no AnimationEvent, so React listens for the webkit-prefixed
    // name; the event carries the animationName the handler checks.
    const ended = new Event("webkitAnimationEnd", { bubbles: true });
    Object.defineProperty(ended, "animationName", { value: "mc-settings-slide-out-left" });
    fireEvent(aside.parentElement!, ended);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("selecting a nav button swaps the page in place", async () => {
    render(<SettingsPanel onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Cores" }));
    expect(await screen.findByText("cores page")).toBeTruthy();
  });
});

void pages;
