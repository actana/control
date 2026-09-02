// @vitest-environment jsdom
//
// Issue 394's acceptance, driven through the real store: **a reload keeps the
// same user terminal on the same project, or clearly has none — never a
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
import type { Project, UserTerminal } from "~/db/schema";

const listHomeTerminals = vi.fn();
const createHomeTerminal = vi.fn();
const deleteHomeTerminal = vi.fn();

vi.mock("~/lib/api", () => ({
  api: {
    listHomeTerminals: () => listHomeTerminals(),
    createHomeTerminal: (body: unknown) => createHomeTerminal(body),
    deleteHomeTerminal: (id: string) => deleteHomeTerminal(id),
    renameHomeTerminal: vi.fn(),
    updateProjectLaunchUrl: vi.fn(),
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

const PROJECT = { id: "p1", path: "/w/p1" } as unknown as Project;
const OTHER_PROJECT = { id: "p2", path: "/w/p2" } as unknown as Project;
const PROJECT_SCOPE = "p1:main";
const HOME_SCOPE = "__home__:local";

function row(id: string, name = "VM shell"): UserTerminal {
  return {
    id,
    name,
    cwd: null,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    projectId: "__home__",
  } as unknown as UserTerminal;
}

/** Mount the store the way the app does — this is a page load. */
function load() {
  return renderHook(() => useUserTerminals(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <UserTerminalProvider>{children}</UserTerminalProvider>
    ),
  });
}

/** Open the app on a project, with a Core in scope. */
async function loadOnProject(project: Project = PROJECT, coreId = "core_a") {
  const view = load();
  await act(async () => {
    view.result.current.setProject(project, coreId);
  });
  return view;
}

/** Open the app on the dashboard (the project-less "home" scope). */
async function loadOnHome() {
  const view = load();
  await act(async () => {
    view.result.current.setHomeActive(true);
  });
  return view;
}

beforeEach(() => {
  window.localStorage.clear();
  listHomeTerminals.mockReset().mockResolvedValue({ terminals: [] });
  createHomeTerminal.mockReset().mockImplementation(async () => ({ terminal: row("t1") }));
  deleteHomeTerminal.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("a reload keeps the same user terminal on the same project (issue 394)", () => {
  it("restores it to that project, on the same Core, as the same kind and cwd", async () => {
    const first = await loadOnProject();
    await act(async () => {
      await first.result.current.createVmShellTerminal("core_a");
    });
    expect(first.result.current.sessions).toHaveLength(1);
    cleanup(); // ---- reload ----

    // The Panel still has the row; the browser still has the identity.
    listHomeTerminals.mockResolvedValue({ terminals: [row("t1")] });
    const second = await loadOnProject();

    await waitFor(() => expect(second.result.current.sessions).toHaveLength(1));
    const restored = second.result.current.sessions[0]!;
    expect(restored.terminal.id).toBe("t1");
    expect(restored.kind).toBe("vm-shell");
    expect(restored.coreId).toBe("core_a");
    expect(restored.cwd).toBe("");
    // Same terminal, same project bucket — not a second one opened beside it.
    expect(createHomeTerminal).toHaveBeenCalledTimes(1);
    expect(Object.keys(second.result.current.sessionsByScope)).toEqual([PROJECT_SCOPE]);
  });

  it("does not hand a project's terminal to Home as a different shell", async () => {
    const first = await loadOnProject();
    await act(async () => {
      await first.result.current.createVmShellTerminal("core_a");
    });
    cleanup(); // ---- reload, this time landing on the dashboard ----

    listHomeTerminals.mockResolvedValue({ terminals: [row("t1")] });
    const second = await loadOnHome();

    await waitFor(() =>
      expect(second.result.current.sessionsByScope[PROJECT_SCOPE]).toHaveLength(1),
    );
    // Home clearly has none: the shell is still the project's, still a VM shell.
    expect(second.result.current.sessions).toEqual([]);
    expect(second.result.current.sessionsByScope[HOME_SCOPE]).toBeUndefined();
    expect(second.result.current.sessionsByScope[PROJECT_SCOPE]![0]!.kind).toBe("vm-shell");
  });

  it("does not hand it to a different project either", async () => {
    const first = await loadOnProject();
    await act(async () => {
      await first.result.current.createVmShellTerminal("core_a");
    });
    cleanup(); // ---- reload on the other project ----

    listHomeTerminals.mockResolvedValue({ terminals: [row("t1")] });
    const second = await loadOnProject(OTHER_PROJECT, "core_a");

    await waitFor(() =>
      expect(second.result.current.sessionsByScope[PROJECT_SCOPE]).toHaveLength(1),
    );
    expect(second.result.current.sessions).toEqual([]);
  });

  it("keeps a Home terminal a VM shell on Home, not a home shell", async () => {
    const first = await loadOnHome();
    await act(async () => {
      await first.result.current.createVmShellTerminal("core_b");
    });
    cleanup(); // ---- reload ----

    listHomeTerminals.mockResolvedValue({ terminals: [row("t1")] });
    const second = await loadOnHome();

    await waitFor(() => expect(second.result.current.sessions).toHaveLength(1));
    const restored = second.result.current.sessions[0]!;
    // The kind that spawns a login shell on the Core — not the `home` flag the
    // old reload path fell back to.
    expect(restored.kind).toBe("vm-shell");
    expect(restored.coreId).toBe("core_b");
  });

  it("shows a row it cannot identify as gone rather than as some other shell", async () => {
    // No identity was ever written for this row (an older build, or a browser
    // whose storage was cleared). Nothing here knows which shell it was.
    listHomeTerminals.mockResolvedValue({ terminals: [row("orphan")] });
    const view = await loadOnHome();

    await waitFor(() => expect(listHomeTerminals).toHaveBeenCalled());
    expect(view.result.current.sessions).toEqual([]);
    expect(Object.values(view.result.current.sessionsByScope).flat()).toEqual([]);
  });

  it("forgets a killed terminal, so a reload does not bring it back", async () => {
    const first = await loadOnProject();
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
    const second = await loadOnProject();
    await waitFor(() => expect(listHomeTerminals).toHaveBeenCalled());
    expect(second.result.current.sessions).toEqual([]);
  });

  it("prunes identities for rows the Panel no longer has", async () => {
    window.localStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({
        stale: { scopeKey: PROJECT_SCOPE, coreId: "core_a", kind: "vm-shell", cwd: "" },
      }),
    );
    listHomeTerminals.mockResolvedValue({ terminals: [] });
    await loadOnProject();
    await waitFor(() => expect(readIdentityMap()).toEqual({}));
  });

  it("still restores when the operator navigates while the list is in flight", async () => {
    // The regression this pins: the restore ran once per app run and threw its
    // answer away if the scope changed first, latching the guard on. Landing on
    // one project on a cold Panel and clicking another before the list answers
    // then left every scope empty, with no retry — the very symptom #394 is
    // about. Restore is decided by each row's identity, not by the scope that
    // happened to be current when the request went out, so a navigation
    // mid-flight cannot change the right answer.
    window.localStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({
        t1: { scopeKey: PROJECT_SCOPE, coreId: "core_a", kind: "vm-shell", cwd: "" },
      }),
    );
    let answer: (value: { terminals: UserTerminal[] }) => void = () => {};
    listHomeTerminals.mockReturnValue(
      new Promise<{ terminals: UserTerminal[] }>((resolve) => {
        answer = resolve;
      }),
    );

    const view = await loadOnProject();
    await waitFor(() => expect(listHomeTerminals).toHaveBeenCalledTimes(1));
    // Navigate away while the request is still open.
    await act(async () => {
      view.result.current.setProject(OTHER_PROJECT, "core_a");
    });
    await act(async () => {
      answer({ terminals: [row("t1")] });
    });

    await waitFor(() =>
      expect(view.result.current.sessionsByScope[PROJECT_SCOPE]).toHaveLength(1),
    );
    const restored = view.result.current.sessionsByScope[PROJECT_SCOPE]![0]!;
    expect(restored.terminal.id).toBe("t1");
    expect(restored.kind).toBe("vm-shell");
    // Still one list call: the answer was used, not discarded and re-requested.
    expect(listHomeTerminals).toHaveBeenCalledTimes(1);
  });

  it("keeps both when a terminal is opened before the list answers", async () => {
    window.localStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({
        before: { scopeKey: PROJECT_SCOPE, coreId: "core_a", kind: "vm-shell", cwd: "" },
      }),
    );
    let answer: (value: { terminals: UserTerminal[] }) => void = () => {};
    listHomeTerminals.mockReturnValue(
      new Promise<{ terminals: UserTerminal[] }>((resolve) => {
        answer = resolve;
      }),
    );
    createHomeTerminal.mockImplementation(async () => ({ terminal: row("opened") }));

    const view = await loadOnProject();
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
    window.localStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({
        t1: { scopeKey: PROJECT_SCOPE, coreId: "core_a", kind: "vm-shell", cwd: "" },
      }),
    );
    listHomeTerminals.mockRejectedValueOnce(new Error("panel restarting"));
    const view = await loadOnProject();
    await waitFor(() => expect(listHomeTerminals).toHaveBeenCalledTimes(1));
    expect(view.result.current.sessions).toEqual([]);
    expect(Object.keys(readIdentityMap())).toEqual(["t1"]);

    // A later scope change tries again rather than leaving the operator with a
    // permanently empty panel.
    listHomeTerminals.mockResolvedValue({ terminals: [row("t1")] });
    await act(async () => {
      view.result.current.setProject(OTHER_PROJECT, "core_a");
    });
    await waitFor(() =>
      expect(view.result.current.sessionsByScope[PROJECT_SCOPE]).toHaveLength(1),
    );
  });
});
