// OpenCode's lifecycle reporting — the one harness family whose extension
// point is a program rather than a table of shell commands.
//
// The other three families in `harness-hooks.ts` are a few lines each because
// the vendor's config file takes a `curl` and the vendor runs it. OpenCode has
// no such file. What it has is a plugin: a JavaScript module, auto-discovered
// from `.opencode/plugin/` or `.opencode/plugins/` with no config entry needed,
// exporting a function that is handed the session's server context and returns
// a table of hooks. That is a different shape of work and it is why opencode
// went without status reporting through issues 84 and 101 and into 230.
//
// The plugin below is that module, kept as a string for one blunt reason: the
// Core ships as an esbuild bundle, and a `.js` asset read from disk at runtime
// is a file that is not in the bundle. A template literal is.
//
// Everything the plugin is allowed to assume about the harness was read out of
// opencode 1.18.18 itself rather than from its docs, and the two places those
// disagree are both load-bearing:
//
//  - The published `@opencode-ai/sdk` type union calls the permission event
//    `permission.updated`. The shipped binary emits `permission.asked` and the
//    string `permission.updated` does not appear in it at all. The plugin
//    listens for both, because being wrong here is a Session that never says
//    it is waiting for the operator.
//  - The docs describe `.opencode/plugin/`; the binary's own onboarding tip
//    says `.opencode/plugins/` and its loader accepts either. We write the
//    plural, which is also where the retired Electron app left its no-op.
//
// The three rules the JSON writers follow apply here unchanged. The file is
// tagged `@actana-control-managed` so a later spawn replaces exactly what an
// earlier one wrote and never an operator's own plugin. It carries no secret —
// the URL, the token and the task id are read from the PTY's environment, so
// the file stays valid across a Core restart that mints a new token. And it is
// fail-soft in every direction: no environment means the plugin does nothing,
// every POST swallows its own errors, and nothing it does is awaited by the
// harness.

import * as fs from "node:fs";
import * as path from "node:path";
import { HOOK_TASK_ID_ENV, HOOK_TOKEN_ENV, HOOK_URL_ENV } from "./harness-hook-env";

/** The comment that marks the file as this Core's to replace. */
export const OPENCODE_PLUGIN_MARKER = "@actana-control-managed";

/** Where opencode auto-discovers it. Plural: see the note above. */
export const OPENCODE_PLUGIN_PATH = path.join(".opencode", "plugins", "actana-control.js");

/**
 * The plugin, as opencode will load it.
 *
 * Written against the `Plugin` contract of `@opencode-ai/plugin` 1.x — a named
 * export that is a function returning a table of hooks — and using only what a
 * Bun runtime supplies (`process.env`, `fetch`), so it needs no dependency, no
 * build step and no `package.json` beside it.
 */
export function opencodePluginSource(slug: string): string {
  return `// ${OPENCODE_PLUGIN_MARKER}
// Actana Control — reports this OpenCode session's lifecycle to the Core that
// spawned it. Written at spawn time; replaced by the next spawn. Delete the
// marker comment on the first line to make this file yours and stop that.

const HOOK_URL = process.env.${HOOK_URL_ENV};
const HOOK_TOKEN = process.env.${HOOK_TOKEN_ENV};
const HOOK_TASK_ID = process.env.${HOOK_TASK_ID_ENV};
const ENDPOINT = ${JSON.stringify(`/api/hooks/${slug}`)};
const TIMEOUT_MS = 3000;

export const ActanaControl = async () => {
  // No environment means no Core listening for this session — a plugin file
  // left behind in a workspace someone opened by hand. Do nothing at all.
  if (!HOOK_URL || !HOOK_TOKEN || !HOOK_TASK_ID) return {};

  // OpenCode's own session is the first one; a subagent runs in a child
  // session, and its busy/idle would otherwise report as the Session's. The
  // parent id is on the created event, so children are known by name rather
  // than guessed at from ordering.
  const children = new Set();

  // Posts are chained so they arrive in the order the harness produced them:
  // a Stop that overtook the UserPromptSubmit carrying the session id would be
  // discarded by the Core as belonging to a session it has never heard of.
  // Nothing awaits the chain — a hook must never hold up a turn.
  let queue = Promise.resolve();

  const send = async (event, body) => {
    const url =
      HOOK_URL +
      ENDPOINT +
      "?taskId=" +
      encodeURIComponent(HOOK_TASK_ID) +
      "&hookEvent=" +
      encodeURIComponent(event);
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + HOOK_TOKEN,
      },
      body: JSON.stringify({ hook_event_name: event, ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  };

  const post = (event, sessionID, extra) => {
    if (!sessionID || children.has(sessionID)) return;
    queue = queue.then(
      () => send(event, { session_id: sessionID, ...extra }).catch(() => {}),
      () => {},
    );
  };

  return {
    // A user message is the start of a turn, the first place the session id is
    // knowable, and the text the Core names an unnamed Session from.
    "chat.message": async (input, output) => {
      const parts = Array.isArray(output?.parts) ? output.parts : [];
      const prompt = parts
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\\n")
        .trim();
      post("UserPromptSubmit", input?.sessionID, prompt ? { prompt } : {});
    },

    event: async ({ event }) => {
      const type = event?.type;
      const props = event?.properties ?? {};

      if (type === "session.created") {
        const info = props.info ?? {};
        if (info.parentID) children.add(info.id);
        else post("SessionStart", info.id, {});
        return;
      }

      // The turn's own start and end. \`session.status\` carries both
      // directions; \`session.idle\` is the older signal and still fires, so
      // both are handled — a duplicate finish is a no-op, a missing one is the
      // bug this file exists for.
      if (type === "session.status") {
        const status = props.status?.type;
        if (status === "busy") post("UserPromptSubmit", props.sessionID, {});
        else if (status === "idle") post("Stop", props.sessionID, {});
        return;
      }
      if (type === "session.idle") {
        post("Stop", props.sessionID, {});
        return;
      }

      // \`permission.asked\` is what 1.18.18 emits; \`permission.updated\` is
      // what the published SDK types call it. Both, deliberately.
      if (type === "permission.asked" || type === "permission.updated") {
        post("PermissionRequest", props.sessionID, {});
        return;
      }
      if (type === "permission.replied") {
        post("PermissionReplied", props.sessionID, {});
      }
    },
  };
};
`;
}

/**
 * Write the plugin into `cwd`, unless a file that is not ours is already
 * sitting at that path.
 *
 * The managed marker is the whole guard. A plugin an operator wrote — or one
 * of ours they took ownership of by deleting the marker line — is theirs, and
 * silently overwriting it would be the same failure as clobbering a settings
 * file we could not parse. Reporting `false` in that case is honest: no hooks
 * of ours are installed, so the Panel keeps its fallback armed.
 */
export function installOpencodeHooks(cwd: string, slug: string): boolean {
  const file = path.join(cwd, OPENCODE_PLUGIN_PATH);
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch (err) {
    // Anything but "not there yet" is a file we cannot account for; leave it.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  if (existing !== null && !existing.includes(OPENCODE_PLUGIN_MARKER)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, opencodePluginSource(slug), "utf8");
    return true;
  } catch {
    return false;
  }
}
