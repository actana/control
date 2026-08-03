import { describe, it, expect, vi } from "vitest";
import { subscribeCoreProjectEvents } from "../subscribe-core-project-events";
import type { CoreLinkEvent } from "@actana/shared/core-link-frames";
import type { PanelBridge } from "~/lib/panel-bridge";

// The filter between "a Core said something happened" and "this view's project
// list is stale". `useCoreProjects` wraps it in an effect; the logic lives here
// so it can be exercised without React. Every Core's events arrive on the one
// panel link, so the coreId tag is what keeps one Core's noise out of another
// Core's view.

type EventListener = (msg: { coreId: string; event: CoreLinkEvent }) => void;

function makeEvent(kind: string, eventId = 1): CoreLinkEvent {
  return { eventId, ts: 0, kind, ptyId: null, taskId: null, payload: "{}" };
}

function fakeBridge(): {
  bridge: PanelBridge;
  emit: EventListener;
  listeners: () => number;
  unsubscribes: () => number;
} {
  const cbs = new Set<EventListener>();
  const state = { unsubscribes: 0 };
  const bridge = {
    onEvent: (cb: EventListener) => {
      cbs.add(cb);
      return () => {
        cbs.delete(cb);
        state.unsubscribes += 1;
      };
    },
  } as unknown as PanelBridge;
  return {
    bridge,
    emit: (msg) => {
      for (const cb of cbs) cb(msg);
    },
    listeners: () => cbs.size,
    unsubscribes: () => state.unsubscribes,
  };
}

describe("subscribeCoreProjectEvents", () => {
  it("fires when the Core reports a project appearing", () => {
    const fake = fakeBridge();
    const onChanged = vi.fn();
    subscribeCoreProjectEvents(fake.bridge, "core_a", onChanged);
    fake.emit({ coreId: "core_a", event: makeEvent("project:created") });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("fires on a rename and on an archive", () => {
    const fake = fakeBridge();
    const onChanged = vi.fn();
    subscribeCoreProjectEvents(fake.bridge, "core_a", onChanged);
    fake.emit({ coreId: "core_a", event: makeEvent("project:renamed") });
    fake.emit({ coreId: "core_a", event: makeEvent("project:archived") });
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("fires on a pin change, so two Panels on one Core agree on the order", () => {
    const fake = fakeBridge();
    const onChanged = vi.fn();
    subscribeCoreProjectEvents(fake.bridge, "core_a", onChanged);
    fake.emit({ coreId: "core_a", event: makeEvent("project:pinnedChanged") });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("ignores another Core's project events on the shared link", () => {
    const fake = fakeBridge();
    const onChanged = vi.fn();
    subscribeCoreProjectEvents(fake.bridge, "core_a", onChanged);
    fake.emit({ coreId: "core_b", event: makeEvent("project:created") });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("ignores events that leave the project list alone", () => {
    const fake = fakeBridge();
    const onChanged = vi.fn();
    subscribeCoreProjectEvents(fake.bridge, "core_a", onChanged);
    fake.emit({ coreId: "core_a", event: makeEvent("task:created") });
    fake.emit({ coreId: "core_a", event: makeEvent("session:finished") });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe that detaches the listener", () => {
    const fake = fakeBridge();
    const onChanged = vi.fn();
    const unsubscribe = subscribeCoreProjectEvents(fake.bridge, "core_a", onChanged);
    unsubscribe();
    fake.emit({ coreId: "core_a", event: makeEvent("project:created") });
    expect(onChanged).not.toHaveBeenCalled();
    expect(fake.unsubscribes()).toBe(1);
  });

  it("is a no-op without a bridge", () => {
    const unsubscribe = subscribeCoreProjectEvents(null, "core_a", vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });

  it("is a no-op without a Core", () => {
    const fake = fakeBridge();
    const unsubscribe = subscribeCoreProjectEvents(fake.bridge, null, vi.fn());
    expect(fake.listeners()).toBe(0);
    expect(() => unsubscribe()).not.toThrow();
  });
});
