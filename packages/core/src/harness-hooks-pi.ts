// Pi's lifecycle reporting — the second harness family whose extension point
// is a program rather than a table of shell commands (OpenCode was the first;
// see harness-hooks-opencode.ts).
//
// Pi (@earendil-works/pi-coding-agent) has no JSON hooks file. What it has is
// an ExtensionAPI: a TypeScript module auto-discovered from
// `~/.pi/agent/extensions/` (or `$PI_CODING_AGENT_DIR/extensions/`) that
// receives a `pi` handle and subscribes to events with `pi.on(...)`. That is
// why this writer lives in its own file rather than as a few lines of JSON
// merge in `harness-hooks.ts`.
//
// The extension below is kept as a string for the same blunt reason as
// OpenCode's: the Core ships as an esbuild bundle, and a `.ts` asset read from
// disk at runtime is a file that is not in the bundle. A template literal is.
//
// Three load-bearing choices (ADR 0039 for placement; ADR 0040 for trust):
//
//  - The file is written to Pi's *global* extensions folder, never to the
//    workspace's `.pi/extensions/`. A workspace-local extension loads only
//    after the project is trusted, and writing one there would itself be a
//    reason for Pi to raise the trust prompt — which is exactly what a
//    status-hook family must not do on first spawn.
//  - Turn end is `agent_settled`, not `agent_end` or `turn_end`. Those fire
//    while Pi may still auto-retry, auto-compact, or drain a follow-up; posting
//    `Stop` on them would finish the card mid-turn. `agent_settled` is the
//    signal Pi documents for "will not continue running automatically".
//  - `project_trust` is answered `{ trusted: "yes" }` only when `event.cwd`
//    resolves to the workspace the Core spawned (`AC_HOOK_CWD`), with no
//    `remember`, so an Actana-spawned Pi never paints "Trust project folder?"
//    for its own workspace and never needs `--approve` / `--no-approve`. A
//    nested `pi` in another directory, or a `/session` resume into a different
//    project, gets no answer and falls through to Pi's trust.json / prompt
//    (ADO #4992 / #519). Hand-run `pi` still gets the interactive prompt,
//    because this whole module is inert without `AC_HOOK_URL`.
//
// The three rules the JSON writers follow apply here unchanged. The file is
// tagged `@actana-control-managed` so a later spawn replaces exactly what an
// earlier one wrote and never an operator's own extension. It carries no
// secret — the URL, the token and the task id are read from the PTY's
// environment. And it is fail-soft in every direction: no `AC_HOOK_URL` means
// the extension does nothing (so `pi` run by hand posts nothing), neither does
// an `AC_HOOK_HARNESS` other than `pi` (a `pi` nested in another harness's
// Session, which inherits that Session's hook env), every POST
// swallows its own errors, and nothing it does is awaited by the harness.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { piAgentDir } from "@actana/shared/pi-agent-dir";
import {
  HOOK_CWD_ENV,
  HOOK_HARNESS_ENV,
  HOOK_MISS_LOG_ENV,
  HOOK_TASK_ID_ENV,
  HOOK_TOKEN_ENV,
  HOOK_URL_ENV,
} from "./harness-hook-env";

/** The comment that marks the file as this Core's to replace. */
export const PI_EXTENSION_MARKER = "@actana-control-managed";

/** Filename under Pi's global extensions folder. */
export const PI_EXTENSION_FILENAME = "actana-control.ts";

/**
 * fs surface `installPiHooks` writes through. Exported so unit tests can
 * spy on it under ESM (where `vi.spyOn(fs, …)` cannot redefine node:fs
 * exports) and assert the temp+rename path never truncates the live file.
 */
export const piExtensionFs = {
  readFileSync: fs.readFileSync.bind(fs) as typeof fs.readFileSync,
  writeFileSync: fs.writeFileSync.bind(fs) as typeof fs.writeFileSync,
  renameSync: fs.renameSync.bind(fs) as typeof fs.renameSync,
  unlinkSync: fs.unlinkSync.bind(fs) as typeof fs.unlinkSync,
  mkdirSync: fs.mkdirSync.bind(fs) as typeof fs.mkdirSync,
};

/** Absolute path of the managed extension file. */
export function piExtensionPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return path.join(piAgentDir(env, home), "extensions", PI_EXTENSION_FILENAME);
}

/**
 * The extension, as Pi will load it.
 *
 * Written against Pi's ExtensionAPI (`export default function (pi) { … }`) and
 * using only what a Node/Bun runtime supplies (`process.env`, `fetch`), so it
 * needs no dependency, no build step and no `package.json` beside it. The
 * source is plain JavaScript in a `.ts` file: Pi's loader accepts both, and
 * skipping type imports keeps the generated file free of a package the Core
 * does not ship into the operator's home.
 */
export function piExtensionSource(slug: string): string {
  return `// ${PI_EXTENSION_MARKER}
// Actana Control — reports this Pi session's lifecycle to the Core that
// spawned it. Written at spawn time into Pi's global extensions folder;
// replaced by the next spawn. Delete the marker comment on the first line to
// make this file yours and stop that.

const HOOK_URL = process.env.${HOOK_URL_ENV};
const HOOK_TOKEN = process.env.${HOOK_TOKEN_ENV};
const HOOK_TASK_ID = process.env.${HOOK_TASK_ID_ENV};
const MISS_LOG = process.env.${HOOK_MISS_LOG_ENV};
const HOOK_HARNESS = process.env.${HOOK_HARNESS_ENV};
const HOOK_CWD = process.env.${HOOK_CWD_ENV};
const ENDPOINT = ${JSON.stringify(`/api/hooks/${slug}`)};
const TIMEOUT_MS = 3000;
const ATTEMPTS = 2;

export default function (pi) {
  // No AC_HOOK_URL means no Core listening for this session — a global
  // extension left behind that an operator opened by hand. Do nothing at all.
  if (!HOOK_URL) return;
  if (!HOOK_TOKEN || !HOOK_TASK_ID) return;
  // A pi an agent started from inside another harness's Session inherits
  // that Session's URL, token and task id. Only a PTY the Core spawned as pi
  // is this extension's to report; anything else would post into, and
  // re-key, a task that is not a Pi Session.
  if (HOOK_HARNESS !== "pi") return;

  // Captured on session_start so later events can address the Core even when
  // a handler's ctx is thin. getSessionId() is the UUID \`pi --session\` takes.
  let sessionId = null;
  // Last interactive/rpc prompt text, attached to the next UserPromptSubmit so
  // the Core can name an unnamed Session the same way Claude's hook does.
  let lastPrompt = null;
  // True from agent_start to agent_settled. Extension dialogs are reported
  // only inside a run: one raised while Pi is idle (an operator's own slash
  // command) would post PermissionReplied -> running when it closed, and no
  // agent_settled would ever come to finish the card.
  let inRun = false;

  // Posts are chained so they arrive in the order the harness produced them.
  // Nothing awaits the chain — a hook must never hold up a turn.
  let queue = Promise.resolve();

  const recordMiss = async (event, reason) => {
    if (!MISS_LOG) return;
    try {
      const fs = await import("node:fs");
      const at = new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
      fs.appendFileSync(MISS_LOG, at + "\\t" + HOOK_TASK_ID + "\\t" + event + "\\t" + reason + "\\n");
    } catch {}
  };

  const send = async (event, body) => {
    const url =
      HOOK_URL +
      ENDPOINT +
      "?taskId=" +
      encodeURIComponent(HOOK_TASK_ID) +
      "&hookEvent=" +
      encodeURIComponent(event);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + HOOK_TOKEN,
      },
      body: JSON.stringify({ hook_event_name: event, ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error("http-" + res.status);
    return res;
  };

  const deliver = async (event, body) => {
    let lastReason = "unknown";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        await send(event, body);
        return;
      } catch (err) {
        lastReason = String((err && err.message) || err).replace(/\\s+/g, " ");
        if (lastReason === "http-404" || lastReason === "http-401") break;
      }
    }
    await recordMiss(event, lastReason);
  };

  const post = (event, id, extra) => {
    if (!id) return;
    queue = queue.then(
      () => deliver(event, { session_id: id, ...extra }).catch(() => {}),
      () => {},
    );
  };

  const idOf = (ctx) => {
    try {
      const next = ctx && ctx.sessionManager && ctx.sessionManager.getSessionId
        ? ctx.sessionManager.getSessionId()
        : null;
      if (next) sessionId = next;
    } catch {}
    return sessionId;
  };

  // Project trust (ADO #4987 / ADR 0040; scoped by ADO #4992 / #519). Pi asks
  // global extensions before painting "Trust project folder?"; answering here
  // for the spawn workspace keeps prompt delivery off that dialog. Session-
  // only — no \`remember\` — so trust.json is not written behind the operator's
  // back. A different folder (nested pi, /session resume) returns undefined so
  // Pi falls through to its own trust.json or prompt. Hand-run \`pi\` never
  // reaches this handler: the early return above left no listeners at all.
  const resolveCwd = async (p) => {
    const pathMod = await import("node:path");
    const fsMod = await import("node:fs");
    const abs = pathMod.resolve(p);
    try {
      return fsMod.realpathSync(abs);
    } catch {
      return abs;
    }
  };

  pi.on("project_trust", async (event, _ctx) => {
    if (!HOOK_CWD || !event || typeof event.cwd !== "string" || !event.cwd) return;
    try {
      if ((await resolveCwd(event.cwd)) !== (await resolveCwd(HOOK_CWD))) return;
    } catch {
      return;
    }
    return { trusted: "yes" };
  });

  // Session UUID first — resume and the session-id guard both need it.
  // \`source\` is Pi's session_start reason, matching Claude's SessionStart shape.
  pi.on("session_start", async (event, ctx) => {
    const extra = event && event.reason ? { source: event.reason } : {};
    post("SessionStart", idOf(ctx), extra);
  });

  // Capture the operator's text before the agent run begins so agent_start
  // can carry it. Extension-injected messages are skipped — they are not an
  // operator prompt.
  pi.on("input", async (event, _ctx) => {
    if (!event || event.source === "extension") return;
    if (typeof event.text === "string" && event.text.trim()) {
      lastPrompt = event.text.trim();
    }
  });

  // Turn start. agent_start fires when a low-level agent run begins.
  pi.on("agent_start", async (_event, ctx) => {
    inRun = true;
    const prompt = lastPrompt;
    lastPrompt = null;
    post("UserPromptSubmit", idOf(ctx), prompt ? { prompt } : {});
  });

  // Turn end. agent_settled — not agent_end / turn_end — is the only signal
  // that fires after auto-retry and compaction have nowhere left to go, so a
  // turn with either reports finished exactly once.
  pi.on("agent_settled", async (_event, ctx) => {
    inRun = false;
    post("Stop", idOf(ctx), {});
  });

  // Extension dialog (select / confirm / input / editor / custom). Posted as
  // QuestionRequest rather than PermissionRequest: Pi's ui_prompt_* wraps
  // extension UI, not a tool-permission gate, and both map to needs-input.
  // Inside a run only — see inRun above.
  pi.on("ui_prompt_start", async (_event, ctx) => {
    if (!inRun) return;
    post("QuestionRequest", idOf(ctx), {});
  });

  pi.on("ui_prompt_end", async (_event, ctx) => {
    if (!inRun) return;
    post("PermissionReplied", idOf(ctx), {});
  });
}
`;
}

/**
 * Write the extension into Pi's global extensions folder, unless a file that
 * is not ours is already sitting at that path.
 *
 * `cwd` is accepted to match the HookFamily install signature and deliberately
 * unused: a workspace-local install would load only after trust and would
 * itself trigger the trust prompt (ADR 0039). The managed marker is the whole
 * guard against clobbering an operator's own extension.
 *
 * `env` must be the environment the Pi PTY will inherit (the spawn env), not
 * the Core daemon's `process.env`. Pi resolves `$PI_CODING_AGENT_DIR` from its
 * own process; writing under the daemon's value while Pi reads a login-shell
 * overlay leaves the extension unloaded and `installed: true` lying (#518).
 * A failed write returns `false` so the Panel keeps its fallback armed.
 *
 * When the on-disk bytes already match `piExtensionSource(slug)`, the write is
 * skipped (#518 part 2). Otherwise the payload lands via a same-directory
 * temp file and `renameSync`, so a concurrent Pi spawn never observes a
 * half-written extension.
 */
export function installPiHooks(
  _cwd: string,
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const file = piExtensionPath(env);
  const desired = piExtensionSource(slug);
  let existing: string | null = null;
  try {
    existing = piExtensionFs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  if (existing !== null && !existing.includes(PI_EXTENSION_MARKER)) return false;
  if (existing === desired) return true;
  const dir = path.dirname(file);
  // Hidden, non-`.ts` name so Pi's extension loader cannot pick the temp up
  // mid-write. Same directory as `file` so rename stays atomic on one FS.
  const tmp = path.join(
    dir,
    `.actana-control-write.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    piExtensionFs.mkdirSync(dir, { recursive: true });
    piExtensionFs.writeFileSync(tmp, desired, "utf8");
    piExtensionFs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      piExtensionFs.unlinkSync(tmp);
    } catch {
      /* best effort — the temp may never have been created */
    }
    return false;
  }
}
