// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBlockedNotifications, type BlockedSession, type BlockedTask } from "../use-blocked-notifications";

// #954 / #928: when blocked work raises a notification. The router, settings, toast, sound and OS notification are the edges.
const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  navigate: vi.fn((..._a: unknown[]) => undefined),
  toast: vi.fn((..._a: unknown[]) => undefined),
  os: vi.fn(async (..._a: unknown[]) => true),
  ding: vi.fn((..._a: unknown[]) => undefined),
}));
vi.mock("~/queries", () => ({ useSettings: () => ({ data: h.settings }) }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: h.navigate }) }));
vi.mock("~/lib/mc-toast", () => ({ mcToastCustom: (...a: unknown[]) => h.toast(...a), McToastActions: () => null, McToastCloseButton: () => null }));
vi.mock("~/lib/notification-sound", () => ({ playNotificationDing: (...a: unknown[]) => h.ding(...a) }));
vi.mock("~/lib/os-notifications", () => ({ showSessionFinishOsNotification: (...a: unknown[]) => h.os(...a) }));
vi.mock("~/lib/session-notification-store", () => ({ requestSessionNotificationOpen: vi.fn() }));

const s = (status: string, over: Partial<BlockedSession> = {}): BlockedSession => ({ coreId: "c1", coreLabel: "berlin", sessionId: "s1", title: "Fix build", status, ...over });
const t = (sessionState: BlockedTask["sessionState"], over: Partial<BlockedTask> = {}): BlockedTask => ({ id: "t1", title: "Rotate keys", sessionState, ...over });

type Props = { sessions: BlockedSession[]; tasks: BlockedTask[] | null; loadedCores?: string[]; viewed: { coreId: string; sessionId: string } | null };
function mount(initial: Partial<Props> = {}) {
  const base: Props = { sessions: [], tasks: [], viewed: null, ...initial };
  const view = renderHook((p: Props) => useBlockedNotifications(p), { initialProps: base });
  return { set: (next: Partial<Props>) => view.rerender({ ...base, ...next }) };
}
const titles = () => h.os.mock.calls.map((c) => (c[0] as { title: string }).title);

beforeEach(() => {
  h.settings = { sessionFinishOsNotificationEnabled: true };
  for (const f of [h.navigate, h.toast, h.os, h.ding]) f.mockClear();
});

describe("blocked-work notifications (#954)", () => {
  it("a Session entering needs-input raises one toast, one OS notification and a ding", () => {
    const m = mount({ sessions: [s("running")] });
    m.set({ sessions: [s("needs-input")] });
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.os).toHaveBeenCalledTimes(1);
    expect(h.ding).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual(["Session needs input on berlin"]);
    expect((h.os.mock.calls[0]![0] as { body: string }).body).toBe("Fix build");
  });

  it("is worded differently from the finished notification", () => {
    const m = mount({ sessions: [s("running")] });
    m.set({ sessions: [s("needs-input")] });
    expect(titles()[0]).not.toMatch(/finished/i);
  });

  it("does not raise again while the Session stays in needs-input", () => {
    const m = mount({ sessions: [s("running")] });
    m.set({ sessions: [s("needs-input")] });
    m.set({ sessions: [s("needs-input", { title: "Fix build!" })] });
    m.set({ sessions: [s("needs-input")] });
    expect(h.os).toHaveBeenCalledTimes(1);
  });

  it("raises again once the Session left needs-input and came back", () => {
    const m = mount({ sessions: [s("running")] });
    m.set({ sessions: [s("needs-input")] });
    m.set({ sessions: [s("running")] });
    m.set({ sessions: [s("needs-input")] });
    expect(h.os).toHaveBeenCalledTimes(2);
  });

  it("does not raise for the Session the Operator is viewing, nor when they look away later", () => {
    const viewed = { coreId: "c1", sessionId: "s1" };
    const m = mount({ sessions: [s("running")], viewed });
    m.set({ sessions: [s("needs-input")], viewed });
    m.set({ sessions: [s("needs-input")], viewed: null });
    expect(h.os).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("raises for another Session than the one in view", () => {
    const viewed = { coreId: "c1", sessionId: "s1" };
    const m = mount({ sessions: [s("running", { sessionId: "s2" })], viewed });
    m.set({ sessions: [s("needs-input", { sessionId: "s2" })], viewed });
    expect(h.os).toHaveBeenCalledTimes(1);
  });

  it("a Session already waiting when the Panel opens is not news", () => {
    mount({ sessions: [s("needs-input")] });
    expect(h.os).not.toHaveBeenCalled();
  });

  it("a Session already waiting on a Core that loads later is not news", () => {
    const m = mount({ sessions: [s("needs-input")] });
    m.set({ sessions: [s("needs-input"), s("needs-input", { coreId: "c2", sessionId: "s9" })] });
    expect(h.os).not.toHaveBeenCalled();
  });

  it("a Task needing input on a Panel opened with no running Task raises (the empty list was loaded)", () => {
    const m = mount({ tasks: [] });
    m.set({ tasks: [t("needs-input")] });
    expect(titles()).toEqual(["Task needs input"]);
  });

  it("a Task list that has not loaded yet is no baseline: nothing raises, and the first loaded list only learns", () => {
    const m = mount({ tasks: null });
    m.set({ tasks: null });
    expect(h.os).not.toHaveBeenCalled();
    m.set({ tasks: [t("needs-input")] });
    expect(h.os).not.toHaveBeenCalled();
  });

  it("a Session needing input on a Core that answered with no Sessions raises", () => {
    const m = mount({ sessions: [], loadedCores: ["c1"] });
    m.set({ sessions: [s("needs-input")], loadedCores: ["c1"] });
    expect(titles()).toEqual(["Session needs input on berlin"]);
  });

  it("a Core that has not answered yet is no baseline", () => {
    const m = mount({ sessions: [], loadedCores: [] });
    m.set({ sessions: [s("needs-input")], loadedCores: [] });
    expect(h.os).not.toHaveBeenCalled();
  });

  it("a Task becoming needs-input or idle-no-result raises, once each", () => {
    const m = mount({ tasks: [t("working")] });
    m.set({ tasks: [t("needs-input")] });
    m.set({ tasks: [t("needs-input")] });
    m.set({ tasks: [t("working")] });
    m.set({ tasks: [t("idle-no-result")] });
    expect(titles()).toEqual(["Task needs input", "Task is idle without a result"]);
  });

  it("a Task becoming interrupted or exited does not raise", () => {
    const m = mount({ tasks: [t("working")] });
    m.set({ tasks: [t("interrupted")] });
    m.set({ tasks: [t("exited")] });
    expect(h.os).not.toHaveBeenCalled();
  });

  it("the blocked toggle off silences both kinds", () => {
    h.settings = { sessionBlockedNotificationEnabled: false, sessionFinishOsNotificationEnabled: true };
    const m = mount({ sessions: [s("running")], tasks: [t("working")] });
    m.set({ sessions: [s("needs-input")], tasks: [t("needs-input")] });
    expect(h.os).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
    expect(h.ding).not.toHaveBeenCalled();
  });

  it("uses the existing toggles: toast off and OS off leave only the ding", () => {
    h.settings = { sessionFinishToastEnabled: false, sessionFinishOsNotificationEnabled: false };
    const m = mount({ sessions: [s("running")] });
    m.set({ sessions: [s("needs-input")] });
    expect(h.toast).not.toHaveBeenCalled();
    expect(h.os).not.toHaveBeenCalled();
    expect(h.ding).toHaveBeenCalledTimes(1);
  });
});
