// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  HARNESSES_AVAILABILITY_EVENT_KIND,
  HARNESS_INSTALL_FAILED_EVENT_KIND,
  type CoreLinkEvent,
  type CoreLinkHarnessAvailabilityMap,
} from "@actana/sdk/core-link-frames";

// The pending-install state (issue 83). It lives beside the availability stores
// and outlives every React thing around it, because what it tracks does too: a
// vendor install runs for minutes across a dialog closing, a remount, and a
// link that drops and comes back.
//
// The rule it exists to keep: a failure is never cached. Not in the availability
// map, not past the next snapshot for that Harness. A stale error that outlived
// its own truth would disable a working Harness with no way back.

type EventListener = (msg: { coreId: string; event: CoreLinkEvent }) => void;

const listeners = new Set<EventListener>();
let ackFor: (harness: string) => Promise<{ accepted: boolean; message?: string }> = async () => ({
  accepted: true,
});

const bridge = {
  isConnected: () => true,
  listHarnessAvailability: vi.fn(async () => SNAPSHOT),
  installHarness: vi.fn((_coreId: string, harness: string) => ackFor(harness)),
  watchCore: vi.fn(() => () => {}),
  onEvent: vi.fn((cb: EventListener) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }),
};

vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => bridge }));

const {
  useHarnessInstall,
  useCliAvailability,
  installStateFor,
  availabilityFor,
  __resetCliAvailabilityStoresForTests,
} = await import("~/lib/cli-availability");

const MISSING: CoreLinkHarnessAvailabilityMap = { "claude-code": { status: "missing" } };
const AVAILABLE: CoreLinkHarnessAvailabilityMap = {
  "claude-code": { status: "available", path: "/usr/bin/claude" },
};
let SNAPSHOT: CoreLinkHarnessAvailabilityMap = MISSING;

function publishAvailability(map: CoreLinkHarnessAvailabilityMap): void {
  act(() => {
    for (const cb of listeners) {
      cb({
        coreId: "core_a",
        event: {
          eventId: 1,
          ts: 0,
          kind: HARNESSES_AVAILABILITY_EVENT_KIND,
          ptyId: null,
          taskId: null,
          payload: JSON.stringify({ availability: map }),
        },
      });
    }
  });
}

function publishFailure(message: string): void {
  act(() => {
    for (const cb of listeners) {
      cb({
        coreId: "core_a",
        event: {
          eventId: 2,
          ts: 0,
          kind: HARNESS_INSTALL_FAILED_EVENT_KIND,
          ptyId: null,
          taskId: null,
          payload: JSON.stringify({ harness: "claude-code", message }),
        },
      });
    }
  });
}

/** Both hooks, as the picker mounts them. */
function mount() {
  return renderHook(() => ({
    install: useHarnessInstall("core_a"),
    availability: useCliAvailability("core_a"),
  }));
}

async function startInstall(view: ReturnType<typeof mount>): Promise<void> {
  await act(async () => {
    view.result.current.install.install("claude-code");
  });
}

describe("pending Harness installs (issue 83)", () => {
  beforeEach(() => {
    SNAPSHOT = MISSING;
    ackFor = async () => ({ accepted: true });
    listeners.clear();
    __resetCliAvailabilityStoresForTests();
    bridge.installHarness.mockClear();
    bridge.onEvent.mockClear();
  });

  afterEach(() => cleanup());

  it("survives the component that started it being unmounted and remounted", async () => {
    const first = mount();
    await startInstall(first);
    expect(installStateFor(first.result.current.install.installs, "claude-code").installing).toBe(
      true,
    );

    first.unmount();
    const second = mount();
    await act(async () => {});

    expect(installStateFor(second.result.current.install.installs, "claude-code").installing).toBe(
      true,
    );
    expect(bridge.installHarness).toHaveBeenCalledTimes(1);
  });

  it("survives a link drop and re-hydration that still reports the Harness missing", async () => {
    const view = mount();
    await startInstall(view);

    // Reconnect: the store re-hydrates from the Core's snapshot, which is
    // honestly still `missing` because the install has not finished. That is
    // not a verdict, and it must not end the install.
    publishAvailability(MISSING);
    expect(installStateFor(view.result.current.install.installs, "claude-code").installing).toBe(
      true,
    );

    publishAvailability(AVAILABLE);
    expect(installStateFor(view.result.current.install.installs, "claude-code")).toEqual({
      installing: false,
    });
  });

  it("does not start a second install for a Harness already installing", async () => {
    const view = mount();
    await startInstall(view);
    await startInstall(view);

    expect(bridge.installHarness).toHaveBeenCalledTimes(1);
  });

  it("ends the install when the link fails, without caching anything in availability", async () => {
    ackFor = async () => {
      throw new Error("core unreachable");
    };
    const view = mount();
    await startInstall(view);

    const state = installStateFor(view.result.current.install.installs, "claude-code");
    expect(state.installing).toBe(false);
    // The Harness is plainly missing again — not errored, not disabled.
    expect(availabilityFor(view.result.current.availability, "claude-code")).toEqual({
      status: "missing",
    });
  });

  it("never lets a failure message survive into the next availability snapshot", async () => {
    const view = mount();
    await startInstall(view);
    publishFailure("Installing Claude Code on this Core failed.");

    expect(installStateFor(view.result.current.install.installs, "claude-code")).toEqual({
      installing: false,
      error: "Installing Claude Code on this Core failed.",
    });
    // The message is not, and never was, part of what the Core says about PATH.
    expect(availabilityFor(view.result.current.availability, "claude-code")).toEqual({
      status: "missing",
    });

    publishAvailability(MISSING);
    expect(installStateFor(view.result.current.install.installs, "claude-code").error).toBeUndefined();
  });

  it("ignores a replayed failure for an install this Panel is not waiting on", async () => {
    // A tab that opens after the fact is served the event tail from its cursor,
    // so an old failure arrives looking new. Nobody here clicked Install, and
    // on a Harness that stays missing no later availability change would come
    // along to clear the message it would otherwise paint.
    const view = mount();
    await act(async () => {});

    publishFailure("Installing Claude Code on this Core failed.");

    expect(installStateFor(view.result.current.install.installs, "claude-code")).toEqual({
      installing: false,
    });
  });

  it("takes a fresh request after a failure", async () => {
    const view = mount();
    await startInstall(view);
    publishFailure("Installing Claude Code on this Core failed.");
    await startInstall(view);

    expect(bridge.installHarness).toHaveBeenCalledTimes(2);
    expect(installStateFor(view.result.current.install.installs, "claude-code")).toEqual({
      installing: true,
    });
  });

  it("shares one event subscription between the two hooks", async () => {
    mount();
    await act(async () => {});
    expect(bridge.onEvent).toHaveBeenCalledTimes(1);
  });
});
