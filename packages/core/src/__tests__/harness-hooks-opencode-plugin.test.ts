// The opencode plugin is a program the Core writes and another vendor's
// runtime executes, which makes it the one hook writer whose output cannot be
// checked by reading it. So this suite loads the generated file the way
// opencode does — an ESM import of a real file on disk — calls the exported
// factory, and drives the hooks it returns.
//
// The event payloads below are the shapes opencode 1.18.18 actually emits,
// taken from a live run of the real binary with this plugin installed. That run
// produced, in order: `SessionStart` carrying `ses_000c0422affe…`,
// `UserPromptSubmit` carrying the prompt text, three more `UserPromptSubmit`
// from the session going busy, and two `Stop`. Everything asserted here is one
// of those.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { opencodePluginSource } from "../harness-hooks-opencode";

type Post = { url: string; auth: string | undefined; body: Record<string, unknown> };

type OpencodeHooks = {
  event?: (input: { event: unknown }) => Promise<void>;
  "chat.message"?: (input: unknown, output: unknown) => Promise<void>;
};

const SESSION = "ses_000c0422afferlN5ASgK5JDYj3";
const CHILD = "ses_child_subagent";

let dir: string;
let posts: Post[];
let loaded = 0;

/**
 * Write the plugin, import it, and return the hook table — the whole path
 * opencode takes, minus opencode. Each call gets its own file so module
 * caching cannot hand one test the previous test's closure.
 */
async function loadPlugin(env: Record<string, string | undefined>): Promise<OpencodeHooks> {
  const file = path.join(dir, `plugin-${(loaded += 1)}.mjs`);
  fs.writeFileSync(file, opencodePluginSource("opencode"), "utf8");
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = (await import(pathToFileURL(file).href)) as {
    ActanaControl: () => Promise<OpencodeHooks>;
  };
  return mod.ActanaControl();
}

const WIRED = {
  AC_HOOK_URL: "http://127.0.0.1:45111",
  AC_HOOK_TOKEN: "hook-token-abc",
  AC_HOOK_TASK_ID: "task_live_1",
};

/** Posts are queued, not awaited by the harness — let the chain drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the OpenCode plugin the Core writes (issue 230)", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-opencode-plugin-"));
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

  const events = (hooks: OpencodeHooks) => async (...list: unknown[]) => {
    for (const event of list) await hooks.event?.({ event });
    await settle();
  };

  it("reports the whole turn: the session id, the start, and the settle", async () => {
    const hooks = await loadPlugin(WIRED);
    const fire = events(hooks);

    await fire({ type: "session.created", properties: { info: { id: SESSION } } });
    await hooks["chat.message"]?.(
      { sessionID: SESSION },
      { message: { role: "user" }, parts: [{ type: "text", text: "say hello" }] },
    );
    await settle();
    await fire(
      { type: "session.status", properties: { sessionID: SESSION, status: { type: "busy" } } },
      { type: "session.status", properties: { sessionID: SESSION, status: { type: "idle" } } },
    );

    expect(posts.map((p) => p.body.hook_event_name)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "UserPromptSubmit",
      "Stop",
    ]);
    // Every one of them carries the session the Core has to match it against.
    expect(posts.every((p) => p.body.session_id === SESSION)).toBe(true);
    // And the prompt text, which is what names an unnamed Session.
    expect(posts[1]!.body.prompt).toBe("say hello");
  });

  it("posts in the order the harness produced them", async () => {
    // The queue is what makes this true. A `Stop` that overtook the
    // `SessionStart` carrying the id would be discarded by the Core as
    // belonging to a session it has never heard of — and the card would sit on
    // `ready` through a turn that ran perfectly, which is issue 230 again with
    // a different cause.
    const hooks = await loadPlugin(WIRED);
    await hooks.event?.({
      event: { type: "session.created", properties: { info: { id: SESSION } } },
    });
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: SESSION } },
    });
    await settle();
    expect(posts.map((p) => p.body.hook_event_name)).toEqual(["SessionStart", "Stop"]);
  });

  it("addresses the Core's receiver, with the task and the event on the URL", async () => {
    const hooks = await loadPlugin(WIRED);
    await events(hooks)({ type: "session.idle", properties: { sessionID: SESSION } });
    expect(posts[0]!.url).toBe(
      "http://127.0.0.1:45111/api/hooks/opencode?taskId=task_live_1&hookEvent=Stop",
    );
    expect(posts[0]!.auth).toBe("Bearer hook-token-abc");
  });

  it("keeps a subagent's busy and idle off the Session's card", async () => {
    // A child session runs a subagent. Its idle is not the turn's end, and
    // letting it through would settle the card while the Session is working.
    const hooks = await loadPlugin(WIRED);
    await events(hooks)(
      { type: "session.created", properties: { info: { id: SESSION } } },
      { type: "session.created", properties: { info: { id: CHILD, parentID: SESSION } } },
      { type: "session.status", properties: { sessionID: CHILD, status: { type: "busy" } } },
      { type: "session.idle", properties: { sessionID: CHILD } },
    );
    expect(posts.map((p) => p.body.hook_event_name)).toEqual(["SessionStart"]);
  });

  it("reports a permission both ways, under either of the vendor's two names", async () => {
    // `permission.asked` is what 1.18.18 emits; `permission.updated` is what
    // the published SDK types call it, and the string does not appear in the
    // shipped binary at all. Listening for one of them was a coin toss.
    for (const asked of ["permission.asked", "permission.updated"]) {
      posts = [];
      const hooks = await loadPlugin(WIRED);
      await events(hooks)(
        { type: asked, properties: { sessionID: SESSION, id: "per_1", title: "run tests" } },
        { type: "permission.replied", properties: { sessionID: SESSION, response: "once" } },
      );
      expect(posts.map((p) => p.body.hook_event_name)).toEqual([
        "PermissionRequest",
        "PermissionReplied",
      ]);
    }
  });

  it("does nothing at all when no Core is listening for this session", async () => {
    // The file outlives the spawn that wrote it. Opened by hand, or by another
    // tool, there is no receiver and no task — and a plugin that posted anyway
    // would be a workspace file making unexplained network calls.
    const hooks = await loadPlugin({
      AC_HOOK_URL: undefined,
      AC_HOOK_TOKEN: undefined,
      AC_HOOK_TASK_ID: undefined,
    });
    expect(hooks).toEqual({});
    expect(posts).toEqual([]);
  });

  it("never lets a failing receiver take the turn down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const hooks = await loadPlugin(WIRED);
    await expect(
      events(hooks)(
        { type: "session.idle", properties: { sessionID: SESSION } },
        { type: "session.idle", properties: { sessionID: SESSION } },
      ),
    ).resolves.toBeUndefined();
  });

  it("ignores an event shape it has never seen without throwing", async () => {
    // The payload is another vendor's, it changes between releases, and a
    // plugin that threw on an unfamiliar one would take the session with it.
    const hooks = await loadPlugin(WIRED);
    await expect(
      events(hooks)(
        {},
        { type: "session.status", properties: {} },
        { type: "message.updated", properties: { info: {} } },
        { type: "session.created", properties: {} },
        null,
      ),
    ).resolves.toBeUndefined();
    expect(posts).toEqual([]);
  });
});
