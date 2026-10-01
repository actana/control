import { describe, expect, it, vi } from "vitest";
import type { Session } from "~/db/schema";
import {
  archivedSessionsEligibleForReap,
  commandForSession,
  nextActiveByProject,
  resolveActiveSessionIdForProject,
  type OpenTerminal,
} from "../terminal-store";

vi.mock("../api", () => ({
  api: {
    updateSession: vi.fn().mockResolvedValue(undefined),
  },
}));

const baseSession = {
  id: "session-1",
  projectId: "project-1",
  title: "Session",
  titleManuallySet: false,
  icon: null,
  status: "ready",
  branch: "main",
  preview: "",
  lines: 0,
  archived: false,
  pinned: false,
  claudeSessionId: null,
  claudeSkipPermissions: false,
  claudeBareSession: false,
  createdAt: 1,
  updatedAt: 1,
} satisfies Omit<Session, "agent">;

describe("commandForSession", () => {
  it("starts a new Claude conversation when a ready session already has a session id", () => {
    const session = {
      ...baseSession,
      agent: "claude-code",
      claudeSessionId: "00000000-0000-4000-8000-000000000000",
    } satisfies Session;

    expect(commandForSession(session)).toBe(
      "claude --session-id 00000000-0000-4000-8000-000000000000 --dangerously-skip-permissions",
    );
  });

  it("resumes Claude conversations after the first launch", () => {
    const session = {
      ...baseSession,
      agent: "claude-code",
      status: "running",
      claudeSessionId: "00000000-0000-4000-8000-000000000000",
    } satisfies Session;

    expect(commandForSession(session)).toBe(
      "claude --resume 00000000-0000-4000-8000-000000000000 --dangerously-skip-permissions",
    );
  });

  it("passes remembered permission-bypass mode to Cursor CLI", () => {
    const session = {
      ...baseSession,
      agent: "cursor-cli",
      claudeSessionId: "00000000-0000-4000-8000-000000000000",
      claudeSkipPermissions: true,
    } satisfies Session;

    expect(commandForSession(session)).toBe(
      "cursor-agent --resume 00000000-0000-4000-8000-000000000000 --force",
    );
  });

  it("starts OpenCode without a session id until one is captured", () => {
    const session = {
      ...baseSession,
      agent: "opencode",
      claudeSessionId: null,
    } satisfies Session;

    expect(commandForSession(session)).toBe("opencode");
  });

  it("resumes OpenCode after a ses_* session id is captured", () => {
    const session = {
      ...baseSession,
      agent: "opencode",
      status: "running",
      claudeSessionId: "ses_3cf7dd8d4ffeUPfENpVxfFojZ2",
    } satisfies Session;

    expect(commandForSession(session)).toBe(
      "opencode --session ses_3cf7dd8d4ffeUPfENpVxfFojZ2",
    );
  });

  it("does not pass legacy UUID session ids to OpenCode", () => {
    const session = {
      ...baseSession,
      agent: "opencode",
      claudeSessionId: "00000000-0000-4000-8000-000000000000",
    } satisfies Session;

    expect(commandForSession(session)).toBe("opencode");
  });

  it("starts Codex with hooks until a session id is captured", () => {
    const session = {
      ...baseSession,
      agent: "codex",
      claudeSessionId: null,
      status: "ready",
    } satisfies Session;

    expect(commandForSession(session)).toBe("codex --enable hooks --yolo");
  });

  it("resumes Codex after the first prompt captured a session id", () => {
    const session = {
      ...baseSession,
      agent: "codex",
      status: "running",
      claudeSessionId: "019d7a0f-432a-7fa1-a821-b7841f983967",
    } satisfies Session;

    expect(commandForSession(session)).toBe(
      "codex resume 019d7a0f-432a-7fa1-a821-b7841f983967 --enable hooks --yolo",
    );
  });
});

describe("nextActiveByProject", () => {
  const scope = "project-1";

  it("selects a session in a scope that had none", () => {
    expect(nextActiveByProject({}, scope, "session-1")).toEqual({ [scope]: "session-1" });
  });

  it("switches active sessions", () => {
    expect(nextActiveByProject({ [scope]: "session-1" }, scope, "session-2")).toEqual({
      [scope]: "session-2",
    });
  });

  // Selection is navigation, not a toggle: a repeat request for the
  // already-active session leaves it selected. The old `nextActiveSessionId` returned
  // null here whenever a session was materialized, and a null scope is the panel
  // close. Materialization is no longer an input to the decision at all.
  it("keeps the session active when it is requested again", () => {
    expect(nextActiveByProject({ [scope]: "session-1" }, scope, "session-1")).toEqual({
      [scope]: "session-1",
    });
  });

  it("returns the same map object for a repeat request so no re-render is forced", () => {
    const prev = { [scope]: "session-1" };
    expect(nextActiveByProject(prev, scope, "session-1")).toBe(prev);
  });

  // A rapid burst follows the last request and never passes through a null
  // (panel-closing) selection. Seeded on A and requesting A first, so this is a
  // repeat-A -> B -> A: a superset of the plain A -> B -> A burst.
  it("follows the last request across a rapid repeat-A -> B -> A burst", () => {
    const seen: (string | null)[] = [];
    let state: Record<string, string | null> = { [scope]: "session-a" };
    for (const requested of ["session-a", "session-b", "session-a"]) {
      state = nextActiveByProject(state, scope, requested);
      seen.push(state[scope] ?? null);
    }
    expect(seen).toEqual(["session-a", "session-b", "session-a"]);
    expect(seen).not.toContain(null);
    expect(state[scope]).toBe("session-a");
  });

  it("leaves other scopes untouched", () => {
    expect(
      nextActiveByProject({ "project-2": "session-9" }, scope, "session-1"),
    ).toEqual({ "project-2": "session-9", [scope]: "session-1" });
  });
});

describe("resolveActiveSessionIdForProject", () => {
  it("prefers the currently visible scope for root panel lookups", () => {
    expect(
      resolveActiveSessionIdForProject(
        {
          "project-1:main": "main-session",
          "project-1:scope-a": "scoped-session",
        },
        "project-1",
        { "project-1": "project-1:scope-a" },
      ),
    ).toEqual({ scopeKey: "project-1:scope-a", sessionId: "scoped-session" });
  });

  it("does not fall back to another scope when the visible scope has no active session", () => {
    expect(
      resolveActiveSessionIdForProject(
        {
          "project-1:main": "main-session",
          "project-1:scope-a": "scoped-session",
        },
        "project-1",
        { "project-1": "project-1:scope-b" },
      ),
    ).toEqual({ scopeKey: "project-1:scope-b", sessionId: null });
  });

  it("uses exact scoped ids without cross-scope fallback", () => {
    expect(
      resolveActiveSessionIdForProject(
        {
          "project-1:main": "main-session",
          "project-1:scope-a": "scoped-session",
        },
        "project-1:scope-b",
      ),
    ).toEqual({ scopeKey: "project-1:scope-b", sessionId: null });
  });

  it("maps legacy plain project active ids to the main scope key", () => {
    expect(
      resolveActiveSessionIdForProject({ "project-1": "legacy-session" }, "project-1"),
    ).toEqual({ scopeKey: "project-1:main", sessionId: "legacy-session" });
  });
});

describe("archivedSessionsEligibleForReap", () => {
  const openTerminal = (opts: {
    sessionId: string;
    projectId?: string;
    archived: boolean;
  }): OpenTerminal => ({
    sessionId: opts.sessionId,
    ptyId: null,
    startCommand: "",
    dangerouslySkipPermissions: false,
    cwd: "/tmp",
    project: {
      id: opts.projectId ?? "project-1",
    } as unknown as OpenTerminal["project"],
    session: { id: opts.sessionId, archived: opts.archived } as OpenTerminal["session"],
  });

  it("reaps an archived session that is not the active selection", () => {
    const sessions = [openTerminal({ sessionId: "a", archived: true })];
    expect(archivedSessionsEligibleForReap(sessions, { "project-1:main": null })).toEqual([
      "a",
    ]);
  });

  it("keeps an archived session alive while it is the active selection", () => {
    const sessions = [openTerminal({ sessionId: "a", archived: true })];
    expect(archivedSessionsEligibleForReap(sessions, { "project-1:main": "a" })).toEqual([]);
  });

  it("never reaps a non-archived session even when it is unselected", () => {
    const sessions = [openTerminal({ sessionId: "a", archived: false })];
    expect(archivedSessionsEligibleForReap(sessions, { "project-1:main": null })).toEqual([]);
  });

  it("returns only the unselected archived sessions", () => {
    const sessions = [
      openTerminal({ sessionId: "a", archived: true }),
      openTerminal({ sessionId: "b", archived: true }),
      openTerminal({ sessionId: "c", archived: false }),
    ];
    expect(archivedSessionsEligibleForReap(sessions, { "project-1:main": "b" })).toEqual([
      "a",
    ]);
  });
});
