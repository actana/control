// Re-verifying this Core's codex hook trust against the codex that is installed (#703).
//
// `harness-pretrust.ts` writes `[hooks.state."<hooks.json>:<event>:<group>:<handler>"]
// trusted_hash` for the hooks this Core installs, reproducing codex's own hash
// (`CODEX_HOOK_HASH_VERIFIED` names the codex release it was read off). A later
// codex may normalise a hook differently, and then the entries only make codex
// ask at its review again, which is the situation before the writer, and nothing
// in this Core would notice. This asks the installed codex itself.
//
// In a throwaway workspace inside the home the real writers put the Core's hooks
// (`installHarnessHooks("codex")`) and the trust entries (`trustCodex`,
// `trustCodexHooks`) in place, exactly as they do for a Session. `codex app-server`
// is then started in that workspace with a throwaway `CODEX_HOME` and asked
// `hooks/list` over its JSON-RPC stdio: one entry per hook codex found, with
// codex's own `currentHash` and its reading of the stored `trusted_hash`
// (`trustStatus`: `trusted` when it matches, `modified` when it does not). Each
// hook this Core installs must be listed, with the Core's hash, as trusted.
//
// Verified against codex 0.162.0 (the request shape, the answer shape, and that a
// hash this Core wrote reads as `trusted` while a wrong one reads as `modified`).
// `hooks/list` lists project hooks only for a trusted project, which is what the
// `trustCodex` entry is for, and needs neither `--enable hooks` nor a login.
//
// Runs where the writers run: in the helper, as `core` (`core-home-ops`, op
// `verifyCodexHookTrust`), once per codex binary and version (`harness-setup.ts`).
// codex is started through `asCore` and signalled through `killAsCore` like every
// other child (`core-identity-guard.test.ts`); in the helper and on metal both
// are the identity, since the process already is core.
// No real config is read or written; the workspace and the `CODEX_HOME` are fresh
// directories under the home and are removed afterwards. A mismatch is reported,
// not repaired: codex asks at its review as it did before the writer, and the
// hash in `harness-pretrust.ts` has to be re-derived by hand from codex's source.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { asCore, killAsCoreQuietly } from "./core-identity";
import { CODEX_HOOK_EVENTS, installHarnessHooks } from "./harness-hooks";
import { ownedCodexHookTrust, trustCodex, trustCodexHooks } from "./harness-pretrust";

/** The `hooks/list` answer has to arrive by then; codex answers in well under a second. */
export const CODEX_HOOK_CHECK_TIMEOUT_MS = 10_000;
/** What codex may print before its answer; its answer is a few kilobytes. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const STDERR_EXCERPT = 300;

/** One hook this Core installs, as codex listed it (or did not). */
export type CodexHookTrustEntry = {
  /** The event as codex spells it in the key: `stop`, `user_prompt_submit`, `permission_request`. */
  event: string;
  /** The `hooks.state` key codex listed the hook under, or the one this Core wrote when codex did not list it. */
  key: string;
  /** The hash this Core wrote as `trusted_hash`. */
  expected: string;
  /** codex's own hash of the hook (`currentHash`), null when codex did not list it. */
  actual: string | null;
  /** codex's reading of the stored `trusted_hash` (`trusted`, `modified`, `untrusted`, …), null when not listed. */
  trustStatus: string | null;
};

export type CodexHookTrustCheck = {
  /** Every hook this Core installs was listed, with this Core's hash, and its stored `trusted_hash` read as trusted. */
  verified: boolean;
  hooks: CodexHookTrustEntry[];
  /** When not verified: why, in one sentence. */
  reason?: string;
};

/** What `hooks/list` says about one hook; only the fields this check reads. */
type ListedHook = { key: string; currentHash: string | null; trustStatus: string | null };

export type CheckCodexHookTrustOptions = {
  timeoutMs?: number;
  /** The spawner; tests pass one that starts a stand-in for codex. */
  spawn?: typeof nodeSpawn;
};

/**
 * Write this Core's codex hooks and their trust entries into a fresh workspace under `scratchRoot`, ask `binary`
 * (`codex app-server`) to list them, and compare. Rejects when codex could not be asked (it did not start, did not
 * answer in time, or answered with something that is not a hook list); resolves, verified or not, when it did.
 */
export async function checkCodexHookTrust(
  binary: string,
  scratchRoot: string,
  env: NodeJS.ProcessEnv,
  options: CheckCodexHookTrustOptions = {},
): Promise<CodexHookTrustCheck> {
  fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(scratchRoot, "codex-hook-check-"));
  try {
    const workspace = path.join(dir, "workspace");
    const codexHome = path.join(dir, "codex-home");
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.mkdirSync(codexHome, { mode: 0o700 });
    if (!installHarnessHooks("codex", workspace, {}).installed) {
      throw new Error("the hooks file could not be written in the check workspace");
    }
    const hooksFile = path.join(workspace, ".codex", "hooks.json");
    // codex keys a project and a hooks file by the resolved path; the home may be a link.
    const spellings = (p: string) => {
      const real = realpathOrNull(p);
      return real !== null && real !== p ? [p, real] : [p];
    };
    const expected = ownedCodexHookTrust(hooksFile, spellings(hooksFile));
    const config = path.join(codexHome, "config.toml");
    trustCodex(config, spellings(workspace));
    trustCodexHooks(config, expected);
    const listed = await listCodexHooks(binary, workspace, { ...env, CODEX_HOME: codexHome }, options);
    return compareCodexHookTrust(expected, listed);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The event label of a `hooks.state` key: `<file>:<event>:<group>:<handler>`, where the file may hold colons. */
function keyEvent(key: string): string {
  const parts = key.split(":");
  return parts.length >= 4 ? parts[parts.length - 3]! : key;
}

/**
 * The comparison on its own: `expected` is what `ownedCodexHookTrust` wrote (a hook may be keyed under more than
 * one spelling of its file; codex lists it once, under the resolved one), `listed` is what codex answered.
 */
export function compareCodexHookTrust(
  expected: readonly (readonly [string, string])[],
  listed: readonly ListedHook[],
): CodexHookTrustCheck {
  // One hook per (event, group, handler), whatever the spelling of its file.
  const owned = new Map<string, { event: string; keys: string[]; hash: string }>();
  for (const [key, hash] of expected) {
    const parts = key.split(":");
    const id = parts.slice(-3).join(":");
    const entry = owned.get(id) ?? { event: keyEvent(key), keys: [], hash };
    entry.keys.push(key);
    owned.set(id, entry);
  }
  const hooks: CodexHookTrustEntry[] = [...owned.values()].map(({ event, keys, hash }) => {
    const found = listed.find((hook) => keys.includes(hook.key));
    return {
      event,
      key: found?.key ?? keys[0]!,
      expected: hash,
      actual: found?.currentHash ?? null,
      trustStatus: found?.trustStatus ?? null,
    };
  });
  const events = (list: CodexHookTrustEntry[]) => list.map((h) => h.event).join(", ");
  const missing = hooks.filter((h) => h.actual === null);
  const differing = hooks.filter((h) => h.actual !== null && h.actual !== h.expected);
  const untrusted = hooks.filter((h) => h.actual === h.expected && h.trustStatus !== "trusted");
  const expectedEvents = CODEX_HOOK_EVENTS.length;
  let reason: string | undefined;
  if (hooks.length < expectedEvents) {
    reason = `this Core wrote ${hooks.length} of its ${expectedEvents} codex hooks into the check workspace`;
  } else if (missing.length > 0) {
    reason = `codex did not list ${events(missing)} from the check workspace`;
  } else if (differing.length > 0) {
    reason = `codex hashes ${events(differing)} differently from this Core`;
  } else if (untrusted.length > 0) {
    reason = `codex reads the trusted_hash this Core wrote for ${events(untrusted)} as ${untrusted.map((h) => h.trustStatus).join(", ")}`;
  }
  return reason === undefined ? { verified: true, hooks } : { verified: false, hooks, reason };
}

/** The three lines of the exchange; codex answers each request on one line of its own. */
function requestLines(cwd: string): string {
  return [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "actana-core", version: "0" }, capabilities: {} } },
    { jsonrpc: "2.0", method: "initialized" },
    { jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [cwd] } },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n")
    .concat("\n");
}

/**
 * `codex app-server` in `cwd`, asked for `hooks/list`. stdin stays open until the answer: codex exits at EOF before
 * it answers what is still queued. Rejects when codex did not start, exited, or did not answer in time, or when
 * its answer is an error or not a hook list.
 */
function listCodexHooks(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: CheckCodexHookTrustOptions,
): Promise<ListedHook[]> {
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? CODEX_HOOK_CHECK_TIMEOUT_MS;
  return new Promise<ListedHook[]>((resolve, reject) => {
    let child: ChildProcess;
    try {
      const launch = asCore({ command: binary, args: ["app-server"], cwd, env });
      child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    const finish = (outcome: { hooks: ListedHook[] } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Nothing of codex's is worth keeping: the home it ran in is thrown away.
      if (child.exitCode === null && child.signalCode === null) killAsCoreQuietly(child, "SIGKILL", "codex-hook-check.kill");
      if ("hooks" in outcome) resolve(outcome.hooks);
      else reject(outcome.error);
    };
    const excerpt = () => stderr.trim().slice(-STDERR_EXCERPT);
    const timer = setTimeout(
      () => finish({ error: new Error(`codex app-server did not answer hooks/list within ${timeoutMs} ms ${excerpt()}`.trim()) }),
      timeoutMs,
    );
    child.on("error", (err) => finish({ error: new Error(`codex app-server could not be started: ${err.message}`) }));
    child.on("exit", (code, signal) => {
      finish({ error: new Error(`codex app-server exited (${code ?? signal}) before answering hooks/list ${excerpt()}`.trim()) });
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-4096);
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        finish({ error: new Error("codex app-server printed more than a hook list before answering hooks/list") });
        return;
      }
      stdout += String(chunk);
      let eol: number;
      while ((eol = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, eol).trim();
        stdout = stdout.slice(eol + 1);
        if (line === "") continue;
        const answer = parseAnswer(line);
        if (answer === null) continue; // a notification, or a line that is not JSON
        if (answer.id === 1 && answer.error) {
          finish({ error: new Error(`codex app-server refused initialize: ${answer.error}`) });
          return;
        }
        if (answer.id !== 2) continue;
        if (answer.error) {
          finish({ error: new Error(`codex app-server refused hooks/list: ${answer.error}`) });
          return;
        }
        if (answer.hooks === null) {
          finish({ error: new Error("codex app-server answered hooks/list with something that is not a hook list") });
          return;
        }
        finish({ hooks: answer.hooks });
        return;
      }
    });
    child.stdin?.on("error", () => {
      /* codex closed its end first; the exit handler says so */
    });
    child.stdin?.write(requestLines(cwd));
  });
}

/** One line of codex's output: its id, its error if any, and its hook list if it is one. */
function parseAnswer(line: string): { id: unknown; error: string | null; hooks: ListedHook[] | null } | null {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(message) || !("id" in message)) return null;
  const error = isRecord(message.error)
    ? typeof message.error.message === "string"
      ? message.error.message
      : JSON.stringify(message.error)
    : null;
  return { id: message.id, error, hooks: error ? null : hookList(message.result) };
}

/** `{ data: [{ cwd, hooks: [{ key, currentHash, trustStatus, … }] }] }`, or null when it is not that. */
function hookList(result: unknown): ListedHook[] | null {
  if (!isRecord(result) || !Array.isArray(result.data)) return null;
  const hooks: ListedHook[] = [];
  for (const entry of result.data) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) return null;
    for (const hook of entry.hooks) {
      if (!isRecord(hook) || typeof hook.key !== "string") return null;
      hooks.push({
        key: hook.key,
        currentHash: typeof hook.currentHash === "string" ? hook.currentHash : null,
        trustStatus: typeof hook.trustStatus === "string" ? hook.trustStatus : null,
      });
    }
  }
  return hooks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}
