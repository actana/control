// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CoreWithDial } from "~/shared/cores";

/**
 * The first-run gate (#358) — the Panel shows the pairing wizard, and nothing
 * else, until it knows a Core.
 *
 * What these tests hold it to is the gate itself, because that is the part that
 * can be wrong in a way nobody notices: that zero Cores means the wizard *and
 * not the dashboard*, that a successful pairing is the only thing that opens
 * the app, that the condition is the live count rather than a first-run flag —
 * so forgetting the last Core puts the wizard back — and that the redemption
 * step is the same `AddCoreByPairing` Settings mounts rather than a second
 * implementation of the most safety-critical flow in the product.
 */

const PRESENTED =
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const ORIGIN = "https://prod-vm-1.internal:7777";

/** The client's error type, as `~/lib/api` declares it. */
class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function core(label = "prod-vm-1"): CoreWithDial {
  return {
    id: "core_new",
    endpoint: "wss://prod-vm-1.internal:7777",
    label,
    lastEventId: 0,
    createdAt: 0,
    updatedAt: 0,
    dial: { coreId: "core_new", state: "connecting", lastSeenAt: null },
  };
}

let CORES: CoreWithDial[] = [];

const api = {
  listCores: vi.fn(async (): Promise<{ cores: CoreWithDial[] }> => ({ cores: CORES })),
  inspectCoreForPairing: vi.fn(async (_address: string) => ({
    identity: { fingerprint: PRESENTED, httpsOrigin: ORIGIN },
  })),
  pairCore: vi.fn(async (_body: unknown): Promise<{ core: CoreWithDial }> => {
    // The registry is what the gate reads, so a pairing that "succeeds" has to
    // land in it — anything else would let the gate pass on a promise rather
    // than on a Core.
    CORES = [core()];
    return { core: core() };
  }),
};

vi.mock("~/lib/api", () => ({ api, ApiError }));

const { FirstRunGate } = await import("../FirstRunGate");
const { announceCoreRegistryChanged } = await import("~/lib/core-registry-changed");
const { writeCachedCoreCount } = await import("~/lib/shell-query-cache");
const { CURRENT_MC_VERSION } = await import("~/queries/mission-control-version");
const { ADD_CORE_LOCATION, composeUpCoreCommand } = await import("~/shared/core-onboarding");
// Warm the chunk the gate loads lazily. `FirstRunWizard` is imported with
// `React.lazy` — it has no business in the entry bundle of a Panel that has a
// fleet — and an unpopulated module registry means React suspends on a promise
// the loader resolves on its own schedule rather than on this tick.
await import("../FirstRunWizard");

const DASHBOARD = "the-dashboard";

/** Settle the registry read, and the lazy wizard behind it. */
async function flush(): Promise<void> {
  await act(async () => {});
}

async function mount(): Promise<void> {
  render(
    <FirstRunGate>
      <div data-testid={DASHBOARD}>Fleet</div>
    </FirstRunGate>,
  );
  await flush();
}

function wizard(): HTMLElement | null {
  return document.querySelector("[data-first-run-wizard]");
}

function dashboard(): HTMLElement | null {
  return screen.queryByTestId(DASHBOARD);
}

function type(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

/** Walk the wizard to a given step. Steps are reference; step 3 is the act. */
async function goToStep(n: 1 | 2 | 3): Promise<void> {
  await click(new RegExp(`Step ${n}`));
}

/** The whole redemption, exactly as an operator does it in Settings. */
async function pair(): Promise<void> {
  await goToStep(3);
  type("Core address", "prod-vm-1.internal:7777");
  await click("Check fingerprint");
  await act(async () => {
    type("CA fingerprint from `actana pair new`", PRESENTED);
  });
  type("Session", "ps_abc");
  type("Pairing code", "k7rp-9x4t");
  await click("Pair Core");
}

describe("the first-run gate (#358)", () => {
  beforeEach(() => {
    CORES = [];
    // The gate seeds its first render from a localStorage count, so a value one
    // test wrote would decide the next test's first paint.
    window.localStorage.clear();
    vi.clearAllMocks();
    api.listCores.mockImplementation(async () => ({ cores: CORES }));
    api.inspectCoreForPairing.mockImplementation(async () => ({
      identity: { fingerprint: PRESENTED, httpsOrigin: ORIGIN },
    }));
    api.pairCore.mockImplementation(async () => {
      CORES = [core()];
      return { core: core() };
    });
  });

  afterEach(() => {
    cleanup();
  });

  describe("what a Panel shows for a given fleet", () => {
    it("shows the wizard, and no dashboard at all, when it knows zero Cores", async () => {
      await mount();
      expect(wizard()).toBeTruthy();
      expect(dashboard()).toBeNull();
      expect(screen.getByRole("heading", { name: "Pair your first Core" })).toBeTruthy();
    });

    it("shows the app, and no wizard, once it knows one", async () => {
      CORES = [core()];
      await mount();
      expect(dashboard()).toBeTruthy();
      expect(wizard()).toBeNull();
    });

    it("shows neither until the registry has answered", async () => {
      // A wizard flashed at an operator with a fleet, or a dashboard flashed at
      // one without, are the two mistakes this component exists to prevent.
      api.listCores.mockImplementation(() => new Promise(() => {}));
      await mount();
      expect(wizard()).toBeNull();
      expect(dashboard()).toBeNull();
    });

    it("paints the shell on the first render when this browser has seen a fleet", async () => {
      // The seed is the whole point: without it every load of every Panel
      // blanks until `listCores()` answers, which is a network round-trip in
      // front of the shell to protect a state only a first-ever load is in.
      writeCachedCoreCount(2);
      api.listCores.mockImplementation(() => new Promise(() => {}));
      render(
        <FirstRunGate>
          <div data-testid={DASHBOARD}>Fleet</div>
        </FirstRunGate>,
      );
      // No flush: this has to be true of the first client render, not of the
      // render after a promise settles.
      expect(dashboard()).toBeTruthy();
      expect(wizard()).toBeNull();
    });

    it("paints the wizard on the first render when this browser has seen none", async () => {
      writeCachedCoreCount(0);
      api.listCores.mockImplementation(() => new Promise(() => {}));
      await mount();
      expect(wizard()).toBeTruthy();
      expect(dashboard()).toBeNull();
    });

    it("keeps the seed honest — the live read corrects it", async () => {
      // A cached count is a memory, not an answer. An operator who forgot their
      // last Core from another browser must not be handed a dashboard.
      writeCachedCoreCount(3);
      CORES = [];
      await mount();
      expect(wizard()).toBeTruthy();
      expect(dashboard()).toBeNull();
    });

    it("never unlocks on a registry read it could not make", async () => {
      api.listCores.mockRejectedValue(new Error("panel unreachable"));
      await mount();
      expect(dashboard()).toBeNull();
      expect(wizard()).toBeTruthy();
      // "No Cores" and "could not ask" are different things, and the operator
      // about to be told to install a Core is owed the difference.
      const box = document.querySelector("[data-first-run-registry-error]");
      expect(box?.textContent).toContain("panel unreachable");
    });
  });

  describe("it is a gate, not a suggestion", () => {
    it("offers nothing that skips, dismisses or defers it, on any step", async () => {
      // A keyword scan cannot prove absence on its own — "Go to Panel" would
      // pass it — which is why the structural test below is the one doing the
      // work. What this catches is an escape hatch added later by someone who
      // named it the obvious thing, and it now looks at all three steps rather
      // than only at the one that happens to be open on mount.
      await mount();
      for (const step of [1, 2, 3] as const) {
        await goToStep(step);
        const escapes = screen
          .getAllByRole("button")
          .map((button) => `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`)
          .filter((name) => /skip|dismiss|later|not now|close|continue anyway|explore/i.test(name));
        expect(escapes).toEqual([]);
      }
    });

    it("keeps the dashboard away on every step of the way through it", async () => {
      await mount();
      for (const step of [1, 2, 3, 2, 1] as const) {
        await goToStep(step);
        expect(dashboard()).toBeNull();
        expect(wizard()).toBeTruthy();
      }
    });

    it("comes back when the last Core is forgotten, because the gate is the count", async () => {
      CORES = [core()];
      await mount();
      expect(dashboard()).toBeTruthy();

      // Settings → Cores → Remove, as far as this component can see it.
      CORES = [];
      await act(async () => {
        announceCoreRegistryChanged();
      });
      await flush();

      expect(wizard()).toBeTruthy();
      expect(dashboard()).toBeNull();
    });

    it("does not tear down a live session on a single empty answer", async () => {
      // Locking the gate unmounts the shell — every terminal, every socket. A
      // Panel server that restarts against an empty or unmigrated data
      // directory answers 200 with nothing in it, and one such answer must not
      // end a session with no prompt and no undo.
      CORES = [core()];
      await mount();
      expect(dashboard()).toBeTruthy();

      api.listCores.mockResolvedValueOnce({ cores: [] });
      const before = api.listCores.mock.calls.length;
      await act(async () => {
        announceCoreRegistryChanged();
      });
      await flush();

      expect(api.listCores.mock.calls.length).toBe(before + 2);
      expect(dashboard()).toBeTruthy();
      expect(wizard()).toBeNull();
    });

    it("does not throw a paired Panel into the wizard over one failed poll", async () => {
      CORES = [core()];
      await mount();
      expect(dashboard()).toBeTruthy();

      api.listCores.mockRejectedValueOnce(new Error("socket hang up"));
      await act(async () => {
        announceCoreRegistryChanged();
      });

      expect(dashboard()).toBeTruthy();
      expect(wizard()).toBeNull();
    });
  });

  describe("what the operator is told to run on the Core", () => {
    it("hands over both install paths on step 1", async () => {
      await mount();
      await goToStep(1);
      expect(
        screen.getByText(
          "curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash",
        ),
      ).toBeTruthy();
      expect(screen.getByText("actana setup")).toBeTruthy();
      expect(screen.getByText(composeUpCoreCommand(CURRENT_MC_VERSION))).toBeTruthy();
    });

    it("brings up the Core alone, at a tag that resolves", async () => {
      // The reader of this screen already has a Panel. A bare `up -d` would
      // start the file's `panel` service too — clashing with theirs on 7420 or
      // shadowing it — and `:latest` does not resolve until a release exists.
      await mount();
      await goToStep(1);
      const compose = screen.getByText(/docker compose .* up -d/);
      expect(compose.textContent?.endsWith("up -d core")).toBe(true);
      expect(compose.textContent).toContain(`ACTANA_TAG=beta-${CURRENT_MC_VERSION}`);
      expect(screen.queryByText("docker compose -f deploy/docker-compose.yml up -d")).toBeNull();
    });

    it("names the mint command on step 2, and what each line it prints is for", async () => {
      await mount();
      await goToStep(2);
      expect(screen.getByText("actana pair new --label <name>")).toBeTruthy();
      expect(screen.getByText(/^Pairing code/)).toBeTruthy();
      expect(screen.getByText(/^CA fingerprint/)).toBeTruthy();
      expect(screen.getByText(/^Session/)).toBeTruthy();
      // The command taught here always carries `--label`, so `pair new` always
      // prints a `Label` line. Leaving it out left one line on the operator's
      // terminal that this screen did not account for.
      expect(screen.getByText(/^Label/)).toBeTruthy();
    });

    it("refuses to print a command the Core would reject, and says why", async () => {
      await mount();
      await goToStep(2);
      await act(async () => {
        type("Name this Panel will have on that Core", "-panel");
      });
      // `pair new` reads a value starting with `-` as another option, in both
      // flag forms, and quoting cannot help. So the placeholder is printed.
      expect(screen.getByText("actana pair new --label <name>")).toBeTruthy();
      expect(screen.queryByText(/--label\s+'?-panel/)).toBeNull();
      expect(document.querySelector("[data-label-refusal]")?.textContent).toMatch(
        /cannot start with/,
      );
    });

    it("rewrites the mint command as the operator names this Panel", async () => {
      await mount();
      await goToStep(2);
      await act(async () => {
        type("Name this Panel will have on that Core", "the office");
      });
      // Quoted, because it is going to be pasted into a shell.
      expect(screen.getByText("actana pair new --label 'the office'")).toBeTruthy();
      expect(screen.queryByText("actana pair new --label <name>")).toBeNull();
    });

    it("keeps every command copyable, since it is pasted on another machine", async () => {
      await mount();
      await goToStep(2);
      const copy = screen.getByRole("button", {
        name: "Copy: actana pair new --label <name>",
      });
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
      await act(async () => {
        fireEvent.click(copy);
      });
      expect(writeText).toHaveBeenCalledWith("actana pair new --label <name>");
    });
  });

  describe("redeeming the code", () => {
    it("is the Settings pairing form, not a second one", async () => {
      await mount();
      await goToStep(3);
      // The ordering `AddCoreByPairing` owns: an address, a fingerprint that
      // has been looked at, and only then a code. If this step had forked the
      // flow, this is where the fork would show.
      expect(screen.getByLabelText("Core address")).toBeTruthy();
      expect(screen.queryByLabelText("Pairing code")).toBeNull();
      expect(document.querySelector("[data-fingerprint-state]")?.getAttribute("data-fingerprint-state")).toBe(
        "unchecked",
      );
      expect(screen.getByText(ADD_CORE_LOCATION)).toBeTruthy();
    });

    it("posts the same body Settings posts", async () => {
      await mount();
      await pair();
      expect(api.pairCore).toHaveBeenCalledWith({
        address: "prod-vm-1.internal:7777",
        code: "k7rp-9x4t",
        sessionId: "ps_abc",
        expectedFingerprint: PRESENTED,
        label: "",
      });
    });

    it("unlocks the dashboard on the first Core that pairs", async () => {
      await mount();
      expect(dashboard()).toBeNull();

      await pair();

      expect(dashboard()).toBeTruthy();
      expect(wizard()).toBeNull();
    });

    it("stays put when the code is refused", async () => {
      await mount();
      api.pairCore.mockRejectedValueOnce(
        new ApiError("that code has been used", 400, {
          failure: "refused",
          error: "that code has been used",
        }),
      );
      await pair();

      expect(wizard()).toBeTruthy();
      expect(dashboard()).toBeNull();
      expect(screen.getByRole("alert").textContent).toContain("that code has been used");
    });
  });
});
