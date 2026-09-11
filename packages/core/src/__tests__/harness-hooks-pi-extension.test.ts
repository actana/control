// The Pi extension is a program the Core writes and Pi's runtime executes,
// which makes it the second hook writer whose output cannot be checked by
// reading it alone. This suite loads the generated file the way a test can —
// an ESM import of a real file on disk — calls the default export with a mock
// `pi` API, and drives the handlers it registers.
//
// Event mapping is taken from Pi ≥ 0.84.4's extension docs: agent_settled (not
// agent_end / turn_end) is the true turn end; ui_prompt_* wraps extension
// dialogs; session_start carries the session UUID via
// ctx.sessionManager.getSessionId().

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piExtensionSource } from "../harness-hooks-pi";

type Post = { url: string; auth: string | undefined; body: Record<string, unknown> };

type PiHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

type MockPi = {
  on: (event: string, handler: PiHandler) => void;
  handlers: Record<string, PiHandler>;
  fire: (event: string, payload?: unknown, ctx?: unknown) => Promise<void>;
};

const SESSION = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

let dir: string;
let posts: Post[];
let loaded = 0;

function mockCtx(sessionId: string = SESSION) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

function createMockPi(): MockPi {
  const handlers: Record<string, PiHandler> = {};
  return {
    handlers,
    on(event, handler) {
      handlers[event] = handler;
    },
    async fire(event, payload = {}, ctx = mockCtx()) {
      await handlers[event]?.(payload, ctx);
    },
  };
}

/**
 * Write the extension, import it, and bind it to a mock pi — the path Pi
 * takes, minus Pi. Each call gets its own file so module caching cannot hand
 * one test the previous test's closure.
 */
async function loadExtension(env: Record<string, string | undefined>): Promise<MockPi> {
  const file = path.join(dir, `extension-${(loaded += 1)}.mjs`);
  fs.writeFileSync(file, piExtensionSource("pi"), "utf8");
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = (await import(pathToFileURL(file).href)) as {
    default: (pi: { on: MockPi["on"] }) => void;
  };
  const pi = createMockPi();
  mod.default(pi);
  return pi;
}

const WIRED = {
  AC_HOOK_URL: "http://127.0.0.1:45112",
  AC_HOOK_TOKEN: "hook-token-pi",
  AC_HOOK_TASK_ID: "task_pi_1",
  AC_HOOK_HARNESS: "pi",
};

/** Posts are queued, not awaited by the harness — let the chain drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the Pi extension the Core writes (ADO #4985)", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-pi-extension-"));
    posts = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        posts.push({
          url,
          auth: (init.headers as Record<string, string>).authorization,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return new Response("{}", { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(WIRED)) delete process.env[key];
  });

  it("reports the whole turn: session id, start, and settle", async () => {
    const pi = await loadExtension(WIRED);

    await pi.fire("session_start", { reason: "startup" });
    await pi.fire("input", { text: "say hello", source: "interactive" });
    await pi.fire("agent_start");
    await settle();
    await pi.fire("agent_settled");
    await settle();

    expect(posts.map((p) => p.body.hook_event_name)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
    ]);
    // SessionStart carries getSessionId() so the pipeline's capture path can
    // store it for `pi --session <uuid>` on relaunch (ADO #4986).
    expect(posts.every((p) => p.body.session_id === SESSION)).toBe(true);
    expect(posts[0]!.body.source).toBe("startup");
    expect(posts[1]!.body.prompt).toBe("say hello");
  });

  it("posts the session UUID on SessionStart before any turn (ADO #4986)", async () => {
    const pi = await loadExtension(WIRED);
    await pi.fire("session_start", { reason: "startup" });
    await settle();

    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      hook_event_name: "SessionStart",
      session_id: SESSION,
      source: "startup",
    });
  });

  it("posts Stop only on agent_settled, never on agent_end or turn_end", async () => {
    // agent_end can fire multiple times during retries/compaction; turn_end
    // fires once per LLM response. agent_settled fires exactly once when the
    // run is truly done — that is the ADR 0033 D1 signal.
    const pi = await loadExtension(WIRED);
    await pi.fire("session_start", { reason: "startup" });
    await pi.fire("agent_start");
    await pi.fire("agent_end", { messages: [] });
    await pi.fire("turn_end", { turnIndex: 0 });
    await pi.fire("agent_end", { messages: [] });
    await pi.fire("agent_settled");
    await settle();

    expect(posts.map((p) => p.body.hook_event_name)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
    ]);
  });

  it("reports an extension dialog as needs-input and clears it on end", async () => {
    const pi = await loadExtension(WIRED);
    await pi.fire("session_start", { reason: "startup" });
    await pi.fire("agent_start");
    await pi.fire("ui_prompt_start", { kind: "confirm", title: "Allow rm?" });
    await pi.fire("ui_prompt_end", { kind: "confirm" });
    await settle();

    expect(posts.map((p) => p.body.hook_event_name)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "QuestionRequest",
      "PermissionReplied",
    ]);
  });

  it("reports nothing for an extension dialog raised while Pi is idle", async () => {
    // An operator's own slash command can open a dialog between turns. Its
    // PermissionReplied would put the card on running with no agent_settled
    // coming to finish it, so only dialogs inside a run are reported.
    const pi = await loadExtension(WIRED);
    await pi.fire("session_start", { reason: "startup" });
    await pi.fire("ui_prompt_start", { kind: "confirm", title: "Reload?" });
    await pi.fire("ui_prompt_end", { kind: "confirm" });
    await pi.fire("agent_start");
    await pi.fire("agent_settled");
    await pi.fire("ui_prompt_start", { kind: "select" });
    await pi.fire("ui_prompt_end", { kind: "select" });
    await settle();

    expect(posts.map((p) => p.body.hook_event_name)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
    ]);
  });

  it("answers project_trust yes without remembering (ADO #4987 / ADR 0040)", async () => {
    // Preferred path: the global extension answers before Pi paints
    // "Trust project folder?", so prompt delivery never sees the dialog.
    // Session-only — no `remember` — so trust.json is not written for the
    // operator.
    const pi = await loadExtension(WIRED);
    const result = await pi.handlers.project_trust?.(
      { type: "project_trust", cwd: "/tmp/ws" },
      { hasUI: true },
    );
    expect(result).toEqual({ trusted: "yes" });
    expect(result).not.toHaveProperty("remember");
    await settle();
    // Answering trust posts nothing — it is a Pi decision, not a Core hook.
    expect(posts).toEqual([]);
  });

  it("does not answer project_trust when AC_HOOK_URL is unset", async () => {
    const pi = await loadExtension({
      AC_HOOK_URL: undefined,
      AC_HOOK_TOKEN: undefined,
      AC_HOOK_TASK_ID: undefined,
    });
    expect(pi.handlers.project_trust).toBeUndefined();
  });

  it("addresses the Core's receiver, with the task and the event on the URL", async () => {
    const pi = await loadExtension(WIRED);
    await pi.fire("agent_settled");
    await settle();
    expect(posts[0]!.url).toBe(
      "http://127.0.0.1:45112/api/hooks/pi?taskId=task_pi_1&hookEvent=Stop",
    );
    expect(posts[0]!.auth).toBe("Bearer hook-token-pi");
  });

  it("posts in the order the harness produced them", async () => {
    const pi = await loadExtension(WIRED);
    await pi.fire("session_start", { reason: "startup" });
    await pi.fire("agent_settled");
    await settle();
    expect(posts.map((p) => p.body.hook_event_name)).toEqual(["SessionStart", "Stop"]);
  });

  it("does nothing at all when AC_HOOK_URL is unset", async () => {
    // The file lives in the operator's global Pi folder and outlives the
    // spawn that wrote it. A hand-run `pi` has no receiver — and must post
    // nothing.
    const pi = await loadExtension({
      AC_HOOK_URL: undefined,
      AC_HOOK_TOKEN: undefined,
      AC_HOOK_TASK_ID: undefined,
    });
    expect(Object.keys(pi.handlers)).toEqual([]);
    await pi.fire("session_start", { reason: "startup" });
    await pi.fire("agent_start");
    await pi.fire("agent_settled");
    await settle();
    expect(posts).toEqual([]);
  });

  it("does nothing in a pi nested inside another harness's Session", async () => {
    // The file is global, so a pi an agent starts from inside a Claude Code
    // Session loads it too, carrying that Session's URL, token and task id.
    // Its SessionStart would re-key the Claude task and its Stop finish it.
    const pi = await loadExtension({ ...WIRED, AC_HOOK_HARNESS: "claude-code" });
    expect(Object.keys(pi.handlers)).toEqual([]);
  });

  it("never lets a failing receiver take the turn down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const pi = await loadExtension(WIRED);
    await expect(
      (async () => {
        await pi.fire("agent_settled");
        await pi.fire("agent_settled");
        await settle();
      })(),
    ).resolves.toBeUndefined();
  });

  it("ignores a missing session id without throwing", async () => {
    const pi = await loadExtension(WIRED);
    await expect(
      (async () => {
        await pi.fire("session_start", { reason: "startup" }, {
          sessionManager: { getSessionId: () => null },
        });
        await pi.fire("agent_start", {}, {});
        await pi.fire("agent_settled", {}, { sessionManager: {} });
        await settle();
      })(),
    ).resolves.toBeUndefined();
    expect(posts).toEqual([]);
  });
});
