// @vitest-environment jsdom
//
// Issue 394's acceptance, driven through the real store: **a reload keeps the
// same user terminal on the same Core, or clearly has none — never a
// different shell.**
//
// The bug was that a terminal's identity lived in memory. Its row persists in
// `home_terminals` whatever scope it was opened in (issue 266), so after a
// reload the row came back stripped of the only things that say which shell it
// is: the project it was opened on, the Core it runs on, its kind and its cwd.
// The project lost its pane, and Home — the one scope that reloaded rows —
// re-spawned it as a plain home shell somewhere else.
//
// A reload here is a real one: the provider is unmounted and a fresh one is
// mounted over the same localStorage, with the API returning the rows the Panel
// still has.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { UserTerminal } from "~/db/schema";

const listHomeTerminals = vi.fn();
const createHomeTerminal = vi.fn();
const deleteHomeTerminal = vi.fn();

vi.mock("~/lib/api", () => ({
  api: {
    listHomeTerminals: () => listHomeTerminals(),
    createHomeTerminal: (body: unknown) => createHomeTerminal(body),
    deleteHomeTerminal: (id: string) => deleteHomeTerminal(id),
    renameHomeTerminal: vi.fn(),
  },
}));
// A store test, not a terminal test: nothing here spawns a PTY or an xterm.
vi.mock("~/lib/panel-bridge", () => ({ getCorePtyBridge: () => null }));
vi.mock("~/lib/prefetch-terminal-modules", () => ({
  prefetchTerminalModules: async () => ({}),
}));
vi.mock("~/lib/terminal-surface-cache", () => ({
  terminalSurfaceCache: { get: () => null, set: vi.fn(), park: vi.fn(), destroy: vi.fn() },
}));

const { UserTerminalProvider, useUserTerminals } = await import("~/lib/user-terminal-store");
const { IDENTITY_STORAGE_KEY, readIdentityMap } = await import("~/lib/user-terminal-identity");

const CORE_A_SCOPE = "core_a:main";

function row(id: string, name = "VM shell"): UserTerminal {
  return {
    id,
    name,
    cwd: null,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Mount the store the way the app does — this is a page load. */
function load() {
  return renderHook(() => useUserTerminals(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <UserTerminalProvider>{children}</UserTerminalProvider>
    ),
  });
}

/** Open the app on a Core. */
async function loadOnCore(coreId = "core_a") {
  const view = load();
  await act(async () => {
    view.result.current.setCore(coreId);
  });
  return view;
}

/** Open the app on the Fleet home, where no Core is in scope. */
function loadOnFleet() {
  return load();
}

beforeEach(() => {
  window.localStorage.clear();
  listHomeTerminals.mockReset().mockResolvedValue({ terminals: [] });
  createHomeTerminal.mockReset().mockImplementation(async () => ({ terminal: row("t1") }));
  deleteHomeTerminal.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("a reload keeps the same user terminal on the same Core (issue 394)", () => {
  it("restores it to that Core, as the same shell", async () => {
    const first = await loadOnCore();
    await act(async () => {
      await first.result.current.createVmShellTerminal("core_a");
    });
    expect(first.result.current.sessions).toHaveLength(1);
    cleanup(); // ---- reload ----

    // The Panel still has the row; the browser still has the identity.
    listHomeTerminals.mockResolvedValue({ terminals: [row("t1")] });
    const second = await loadOnCore();

    await waitFor(() => expect(second.result.current.sessions).toHaveLength(1));
    const restored = second.result.current.sessions[0]!;
    expect(restored.terminal.id).toBe("t1");
    expect(restored.coreId).toBe("core_a");
    // Same terminal, same Core bucket — not a second one opened beside it.
    expect(createHomeTerminal).toHaveBeenCalledTimes(1);
    expect(Object.keys(second.result.current.sessionsByScope)).toEqual([CORE_A_SCOPE]);
  });

  it("restores nothing until a Core is in scope, then puts it back on its Core", async () => {
    const first = await loadOnCore();
    await act(async () => {
      await first.result.current.createVmShellTerminal("core_a");
    });
    cleanup(); // ---- reload, this time landing on the Fleet home ----

    listHomeTerminals.mockClear().mockResolvedValue({ terminals: [row("t1")] });
    const second = loadOnFleet();
    await act(async () => {});

    // No Core, no terminal drawer: nothing is shown, and nothing is asked.
    expect(second.result.current.sessions).toEqual([]);
    expect(listHomeTerminals).not.toHaveBeenCalled();

    await act(async () => {
      second.result.current.setCore("core_a");
    });
    await waitFor(() => expect(second.result.current.sessions).toHaveLength(1));
    expect(second.result.current.sessions[0]!.coreId).toBe("core_a");
  });

  it("does not hand it to a different Core either", async () => {
    const first = await loadOnCore();
    await act(async () => {
      await first.result.current.createVmShellTerminal("core_a");
    });
    cleanup(); // ---- reload on the other Core ----

    listHomeTerminals.mockResolvedValue({ terminals: [row("t1")] });
    const second = await loadOnCore("core_b");

    await waitFor(() =>
      expect(second.result.current.sessionsByScope[CORE_A_SCOPE]).toHaveLength(1),
    );
    expect(second.result.current.sessions).toEqual([]);
  });

  it("puts a terminal opened under the old home scope on its Core", async () => {
    // Written while the drawer on a Core page used the project-less home scope:
    // the identity names a scope that no longer exists, and the Core it ran on.
    window.localStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({
        t1: { scopeKey: "__home__:local", coreId: "core_b", kind: "vm-shell", cwd: "" },
      }),
    );
    listHomeTerminals.mockResolvedValue({ terminals: [row("t1")] });

    const view = await loadOnCore("core_b");

    await waitFor(() => expect(view.result.current.sessions).toHaveLength(1));
    expect(view.result.current.sessions[0]!.coreId).toBe("core_b");
  });

  it("shows a row it cannot identify as gone rather than as some other shell", async () => {
    // No identity was ever written for this row (an older build, or a browser
    // whose storage was cleared). Nothing here knows which Core it ran on.
    listHomeTerminals.mockResolvedValue({ terminals: [row("orphan")] });
    const view = await loadOnCore();

    await waitFor(() => expect(listHomeTerminals).toHaveBeenCalled());
    expect(view.result.current.sessions).toEqual([]);
    expect(Object.values(view.result.current.sessionsByScope).flat()).toEqual([]);
  });

  it("does not restore a shell recorded as a project shell, which can no longer be spawned", async () => {
    window.localStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({
        t1: { scopeKey: "p1:main", coreId: "core_a", kind: "project", cwd: "/w/p1" },
      }),
    );
    listHomeTerminals.mockResolvedValue({ terminals: [row("t1")] });

    const view = await loadOnCore();

    await waitFor(() => expect(listHomeTerminals).toHaveBeenCalled());
    expect(view.result.current.sessions).toEqual([]);
  });

  it("forgets a killed terminal, so a reload does not bring it back", async () => {
    const first = await loadOnCore();
    await act(async () => {
      await first.result.current.createVmShellTerminal("core_a");
    });
    await act(async () => {
      await first.result.current.killTerminal("t1");
    });
    await waitFor(() => expect(readIdentityMap()).toEqual({}));
    cleanup(); // ---- reload ----

    // The row is gone server-side too; the identity must not outlive it.
    listHomeTerminals.mockResolvedValue({ terminals: [] });
    const second = await loadOnCore();
    await waitFor(() => expect(listHomeTerminals).toHaveBeenCalled());
    expect(second.result.current.sessions).toEqual([]);
  });

  it("prunes identities for rows the Panel no longer has", async () => {
    window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify({ stale: { coreId: "core_a" } }));
    listHomeTerminals.mockResolvedValue({ terminals: [] });
    await loadOnCore();
    await waitFor(() => expect(readIdentityMap()).toEqual({}));
  });

  it("still restores when the operator navigates while the list is in flight", async () => {
    // The regression this pins: the restore ran once per app run and threw its
    // answer away if the scope changed first, latching the guard on. Landing on
    // one Core on a cold Panel and clicking another before the list answers
    // then left every scope empty, with no retry — the very symptom #394 is
    // about. Restore is decided by each row's identity, not by the scope that
    // happened to be current when the request went out, so a navigation
    // mid-flight cannot change the right answer.
    window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify({ t1: { coreId: "core_a" } }));
    let answer: (value: { terminals: UserTerminal[] }) => void = () => {};
    listHomeTerminals.mockReturnValue(
      new Promise<{ terminals: UserTerminal[] }>((resolve) => {
        answer = resolve;
      }),
    );

    const view = await loadOnCore();
    await waitFor(() => expect(listHomeTerminals).toHaveBeenCalledTimes(1));
    // Navigate away while the request is still open.
    await act(async () => {
      view.result.current.setCore("core_b");
    });
    await act(async () => {
      answer({ terminals: [row("t1")] });
    });

    await waitFor(() =>
      expect(view.result.current.sessionsByScope[CORE_A_SCOPE]).toHaveLength(1),
    );
    const restored = view.result.current.sessionsByScope[CORE_A_SCOPE]![0]!;
    expect(restored.terminal.id).toBe("t1");
    // Still one list call: the answer was used, not discarded and re-requested.
    expect(listHomeTerminals).toHaveBeenCalledTimes(1);
  });

  it("keeps both when a terminal is opened before the list answers", async () => {
    window.localStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({ before: { coreId: "core_a" } }),
    );
    let answer: (value: { terminals: UserTerminal[] }) => void = () => {};
    listHomeTerminals.mockReturnValue(
      new Promise<{ terminals: UserTerminal[] }>((resolve) => {
        answer = resolve;
      }),
    );
    createHomeTerminal.mockImplementation(async () => ({ terminal: row("opened") }));

    const view = await loadOnCore();
    await act(async () => {
      await view.result.current.createVmShellTerminal("core_a");
    });
    await act(async () => {
      answer({ terminals: [row("before")] });
    });

    // The pre-reload terminal joins the one just opened rather than the whole
    // bucket being skipped because it was no longer empty.
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    expect(view.result.current.sessions.map((s) => s.terminal.id)).toEqual([
      "before",
      "opened",
    ]);
    // And the identity written during the window survives the prune the answer
    // triggers: it is absent from that answer because it did not exist yet.
    expect(Object.keys(readIdentityMap()).sort()).toEqual(["before", "opened"]);
  });

  it("leaves the identity alone when the list call fails, and retries later", async () => {
    window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify({ t1: { coreId: "core_a" } }));
    listHomeTerminals.mockRejectedValueOnce(new Error("panel restarting"));
    const view = await loadOnCore();
    await waitFor(() => expect(listHomeTerminals).toHaveBeenCalledTimes(1));
    expect(view.result.current.sessions).toEqual([]);
    expect(Object.keys(readIdentityMap())).toEqual(["t1"]);

    // A later scope change tries again rather than leaving the operator with a
    // permanently empty panel.
    listHomeTerminals.mockResolvedValue({ terminals: [row("t1")] });
    await act(async () => {
      view.result.current.setCore("core_b");
    });
    await waitFor(() =>
      expect(view.result.current.sessionsByScope[CORE_A_SCOPE]).toHaveLength(1),
    );
  });
});
