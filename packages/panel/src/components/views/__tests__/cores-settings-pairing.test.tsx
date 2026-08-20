// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CoreWithDial } from "~/shared/cores";
import type { CorePairingFailureCode, CorePairingRefusal } from "~/shared/core-pairing";

/**
 * Adding a Core from Settings → Cores, by short code (#286).
 *
 * The page's job here is a sequence, not a form: an address, then a fingerprint
 * the operator looks at, and only then a code. What these tests hold it to is
 * the part a server-side suite cannot see — that the three fingerprint states
 * are visibly three, that a mismatch has nothing to click past, and that a
 * "verified" badge is never worn on behalf of a machine the box is no longer
 * pointed at.
 */

const PRESENTED = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const OTHER = `11:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99`;
const ORIGIN = "https://prod-vm-1.internal:7777";

/** The client's error type, as `~/lib/api` declares it — the mock stands in for the module. */
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

function paired(label = "prod-vm-1"): CoreWithDial {
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

const api = {
  listCores: vi.fn(async (): Promise<{ cores: CoreWithDial[] }> => ({ cores: CORES })),
  inspectCoreForPairing: vi.fn(async (_address: string) => ({
    identity: { fingerprint: PRESENTED, httpsOrigin: ORIGIN },
  })),
  pairCore: vi.fn(async (_body: unknown): Promise<{ core: CoreWithDial }> => ({ core: paired() })),
  renameCore: vi.fn(),
  removeCore: vi.fn(async () => undefined),
  addCore: vi.fn(),
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
};

const toasts = { success: vi.fn(), error: vi.fn() };

vi.mock("~/lib/api", () => ({ api, ApiError }));
vi.mock("sonner", () => ({ toast: toasts }));

const { CoresSettingsPage } = await import("../CoresSettingsPage");
const { KeybindingsProvider } = await import("~/lib/keybindings/store");
const { pairingFailureMessage } = await import("~/shared/core-pairing");

let CORES: CoreWithDial[] = [];

async function openPage(): Promise<void> {
  render(
    <KeybindingsProvider>
      <CoresSettingsPage />
    </KeybindingsProvider>,
  );
  await act(async () => {});
}

function fingerprintPanel(): HTMLElement {
  const el = document.querySelector("[data-fingerprint-state]");
  if (!el) throw new Error("no fingerprint panel rendered");
  return el as HTMLElement;
}

function state(): string | null {
  return fingerprintPanel().getAttribute("data-fingerprint-state");
}

function type(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

/** Address in, fingerprint read off the Core. Stops short of confirming it. */
async function checkFingerprint(address = "prod-vm-1.internal:7777"): Promise<void> {
  type("Core address", address);
  await click("Check fingerprint");
}

/** The whole way to a verified fingerprint, which is what unlocks the code. */
async function verify(): Promise<void> {
  await checkFingerprint();
  await act(async () => {
    type("CA fingerprint from `actana pair new`", PRESENTED);
  });
}

function refusalOf(failure: CorePairingFailureCode, extra: Partial<CorePairingRefusal> = {}): ApiError {
  const refusal: CorePairingRefusal = {
    failure,
    error: pairingFailureMessage(failure, extra),
    ...extra,
  };
  return new ApiError(refusal.error, 400, refusal);
}

describe("adding a Core by short code (#286)", () => {
  beforeEach(() => {
    CORES = [];
    vi.clearAllMocks();
    api.listCores.mockImplementation(async () => ({ cores: CORES }));
    api.inspectCoreForPairing.mockImplementation(async () => ({
      identity: { fingerprint: PRESENTED, httpsOrigin: ORIGIN },
    }));
    api.pairCore.mockImplementation(async () => ({ core: paired() }));
  });

  afterEach(() => {
    cleanup();
  });

  it("asks for an address and a code, not for a blob to paste", async () => {
    await openPage();
    expect(screen.getByLabelText("Core address")).toBeTruthy();
    expect(screen.queryByPlaceholderText("paste the pairing token here…")).toBeNull();
    expect(screen.queryByLabelText("Pairing token")).toBeNull();
  });

  describe("the three fingerprint states", () => {
    it("starts not-yet-checked, with nowhere to type a code", async () => {
      await openPage();
      expect(state()).toBe("unchecked");
      expect(screen.queryByLabelText("Pairing code")).toBeNull();
      expect(screen.getByRole("button", { name: "Pair Core" })).toHaveProperty("disabled", true);
    });

    it("stays not-yet-checked once the Core has answered but nothing is compared", async () => {
      await openPage();
      await checkFingerprint();
      // The fingerprint is on screen to be compared — and until it has been,
      // this is still the unchecked state and there is still no code field.
      expect(screen.getByText(PRESENTED)).toBeTruthy();
      expect(state()).toBe("unchecked");
      expect(screen.queryByLabelText("Pairing code")).toBeNull();
    });

    it("reads verified when the two strings are the same, and opens the code", async () => {
      await openPage();
      await verify();
      expect(state()).toBe("verified");
      expect(screen.getByLabelText("Pairing code")).toBeTruthy();
      expect(screen.getByLabelText("Session")).toBeTruthy();
    });

    it("reads mismatched, shows both, and has nothing to click past", async () => {
      await openPage();
      await checkFingerprint();
      await act(async () => {
        type("CA fingerprint from `actana pair new`", OTHER);
      });

      expect(state()).toBe("mismatch");
      expect(fingerprintPanel().getAttribute("role")).toBe("alert");
      // Both halves of the disagreement are on screen.
      expect(screen.getByText("Expected")).toBeTruthy();
      expect(screen.getByText("Presented")).toBeTruthy();
      expect(screen.getAllByText(OTHER).length).toBeGreaterThan(0);
      expect(screen.getAllByText(PRESENTED).length).toBeGreaterThan(0);
      // A refusal, not a warning: there is no code box and no way to send one.
      expect(screen.queryByLabelText("Pairing code")).toBeNull();
      expect(screen.getByRole("button", { name: "Pair Core" })).toHaveProperty("disabled", true);
      expect(api.pairCore).not.toHaveBeenCalled();
    });

    it("takes the fingerprint the way a human copies it off a terminal", async () => {
      await openPage();
      await checkFingerprint();
      await act(async () => {
        type("CA fingerprint from `actana pair new`", `  sha256:${PRESENTED.replace(/:/g, "").toLowerCase()}  `);
      });
      expect(state()).toBe("verified");
    });

    it("drops a verified fingerprint when the address changes under it", async () => {
      await openPage();
      await verify();
      expect(state()).toBe("verified");

      await act(async () => {
        type("Core address", "other-box.internal:7777");
      });

      // A badge earned by one machine must not be worn by another.
      expect(state()).toBe("unchecked");
      expect(screen.queryByLabelText("Pairing code")).toBeNull();
    });
  });

  describe("sending the code", () => {
    it("posts what the operator was read out, and reports the paired Core", async () => {
      await openPage();
      await verify();
      type("Session", " ps_abc ");
      type("Pairing code", "k7rp-9x4t");
      type("Name in this Panel (optional)", " prod-vm-1 ");

      await click("Pair Core");

      expect(api.pairCore).toHaveBeenCalledWith({
        address: "prod-vm-1.internal:7777",
        code: "k7rp-9x4t",
        sessionId: "ps_abc",
        expectedFingerprint: PRESENTED,
        label: "prod-vm-1",
      });
      expect(toasts.success).toHaveBeenCalledWith('Core "prod-vm-1" paired.');
    });

    it("takes a code typed without its hyphen, in whatever case", async () => {
      await openPage();
      await verify();
      type("Session", "ps_abc");
      type("Pairing code", "k7rp9x4t");
      expect(screen.getByRole("button", { name: "Pair Core" })).toHaveProperty("disabled", false);

      await click("Pair Core");
      expect(api.pairCore).toHaveBeenCalledWith(expect.objectContaining({ code: "k7rp9x4t" }));
    });

    it("will not send a code that could not be one, or one with no session", async () => {
      await openPage();
      await verify();
      type("Session", "ps_abc");
      type("Pairing code", "k7rp");
      expect(screen.getByRole("button", { name: "Pair Core" })).toHaveProperty("disabled", true);

      type("Pairing code", "k7rp9x4t");
      type("Session", "  ");
      expect(screen.getByRole("button", { name: "Pair Core" })).toHaveProperty("disabled", true);
    });

    it("clears the form once the Core is in the fleet", async () => {
      await openPage();
      await verify();
      type("Session", "ps_abc");
      type("Pairing code", "k7rp-9x4t");
      await click("Pair Core");

      expect((screen.getByLabelText("Core address") as HTMLInputElement).value).toBe("");
      expect(state()).toBe("unchecked");
      expect(screen.queryByLabelText("Pairing code")).toBeNull();
    });
  });

  describe("failures the operator has to tell apart", () => {
    const FAILURES: CorePairingFailureCode[] = [
      "bad-address",
      "bad-code",
      "bad-fingerprint",
      "unreachable",
      "no-ca-presented",
      "fingerprint-unconfirmed",
      "hostname-mismatch",
      "certificate-invalid",
      "refused",
      "rate-limited",
      "rejected",
      "not-pairable",
      "core-error",
      "malformed-response",
    ];

    it.each(FAILURES)("renders a message of its own for %s", async (failure) => {
      await openPage();
      await verify();
      type("Session", "ps_abc");
      type("Pairing code", "k7rp-9x4t");
      api.pairCore.mockRejectedValueOnce(refusalOf(failure));

      await click("Pair Core");

      const box = document.querySelector(`[data-pairing-failure="${failure}"]`);
      expect(box).toBeTruthy();
      expect(box!.textContent).toBe(pairingFailureMessage(failure));
    });

    it("says something different for each of them", async () => {
      const said = new Set(FAILURES.map((failure) => pairingFailureMessage(failure)));
      expect(said.size).toBe(FAILURES.length);
    });

    it("names the wait when the Core asked for one", async () => {
      await openPage();
      await verify();
      type("Session", "ps_abc");
      type("Pairing code", "k7rp-9x4t");
      api.pairCore.mockRejectedValueOnce(refusalOf("rate-limited", { retryAfterSeconds: 42 }));

      await click("Pair Core");
      expect(screen.getByRole("alert").textContent).toContain("42s");
    });

    it("empties the box on a refusal, and never prints the code that was in it", async () => {
      await openPage();
      await verify();
      type("Session", "ps_abc");
      type("Pairing code", "k7rp-9x4t");
      api.pairCore.mockRejectedValueOnce(refusalOf("refused"));

      await click("Pair Core");

      // Spent, dead or wrong — a second attempt could only burn another of the
      // session's five, and the code has no reason to still be in memory.
      expect((screen.getByLabelText("Pairing code") as HTMLInputElement).value).toBe("");
      expect(document.body.textContent).not.toContain("k7rp-9x4t");
      expect(document.body.textContent).not.toContain("K7RP-9X4T");
    });

    it("falls back to something true when the failure is not a refusal at all", async () => {
      await openPage();
      await verify();
      type("Session", "ps_abc");
      type("Pairing code", "k7rp-9x4t");
      api.pairCore.mockRejectedValueOnce(new Error("socket hang up"));

      await click("Pair Core");

      const box = document.querySelector('[data-pairing-failure="core-error"]');
      expect(box).toBeTruthy();
      expect(box!.textContent).toContain("Nothing was paired");
    });

    it("reports a first-contact dial that failed, without offering a code box", async () => {
      await openPage();
      api.inspectCoreForPairing.mockRejectedValueOnce(refusalOf("unreachable"));
      await checkFingerprint();

      expect(document.querySelector('[data-pairing-failure="unreachable"]')).toBeTruthy();
      expect(state()).toBe("unchecked");
      expect(screen.queryByLabelText("Pairing code")).toBeNull();
    });
  });
});
