// What the daemon asks a `core` process to do in core's home (issue 559, PR 3).
//
// In the container the daemon is `actana`, and `core`'s home is 0750 core:core:
// every short read or write the daemon used to make there (a hook file in the
// workspace, `~/.claude/settings.json`, the skill folders, the registry blob)
// would fail with EACCES, and widening the home's permissions is the wrong fix. So each one is a *request* here, and the code
// that touches the disk runs in a short-lived process started through `asCore`
// (`core-home-ops-client.ts` starts it, `core-home-ops-main.ts` is its entry).
//
// The protocol is one JSON request on stdin and one JSON answer on stdout. The
// request names one of the operations in {@link CORE_HOME_OPERATIONS}; nothing
// else is accepted, and nothing in a request is a command, a script or an
// environment.
//
// **This module is the helper's half.** It is also what runs in-process outside
// the container, where there is no second user and the client calls
// {@link handleCoreHomeOp} directly, so metal installs and every existing test
// behave exactly as before. The writers below are reachable from the daemon only
// through the client: the daemon-side modules (pty-manager, core-entry,
// core-exec, core-self-register) do not import them, and
// `core-home-ops-guard.test.ts` fails when one does.
//
// **Validation is the point of the module.** The helper runs as `core`, so it can
// do no more than a Session can. A confused deputy is still a bug: a request must
// not be able to make it write outside the home, or through a link that leaves
// it. In the container (`ctx.roots` set) every path a request names is confined:
//   1. it is absolute, has no NUL, and is under a root once normalised (`..`
//      is gone before the comparison, not after);
//   2. the deepest part of it that exists resolves, through `realpath`, to a
//      place still under the root's own `realpath`, and a dangling link on the
//      way is refused. A link a Session planted inside the home that points out
//      of it is refused, not followed.
// Outside the container `ctx.roots` is null: daemon and operator are one user
// and there is nothing to confine against.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pickHarnessCandidateMeetingVersion, resolveAllHarnessCommandsOnPath } from "@actana/shared/harness-cli-resolution";
import { HARNESS_CLI_CONFIG_BY_COMMAND } from "@actana/shared/harness-cli-config";
import type { HarnessVersionCheck } from "@actana/shared/harness-cli-version";
import { registryPaths } from "@actana/shared/blob-registry";
import { wireLocalCore, type LocalCoreWiring } from "@actana/shared/local-core-wiring";
import { piAgentDir } from "@actana/shared/pi-agent-dir";
import { ensureStatuslineTap, statuslineTapPath } from "@actana/shared/statusline-tap";
import type { SkillInstallEntry } from "@actana/shared/orchestration-skill-install";
import { checkCodexHookTrust, type CodexHookTrustCheck } from "./codex-hook-trust-check";
import { hookWritePaths, installHarnessHooks, type HookInstallResult } from "./harness-hooks";
import { installOrchestrationSkills, orchestrationSkillFolders } from "./orchestration-skill";
import {
  claudeConfigPath,
  codexConfigPath,
  cursorMarkerPath,
  ownedCodexHookTrust,
  pretrustWorkspaces,
  trustCodexHooks,
  type PretrustResult,
} from "./harness-pretrust";

/** The only operations the helper will run. A name not in this list is refused. */
export const CORE_HOME_OPERATIONS = [
  "installHarnessHooks",
  "ensureStatuslineTap",
  "ensureClaudeShiftEnterBinding",
  "ensureOrchestrationSkill",
  "wireLocalCore",
  "spawnPathFacts",
  "resolveExecCwd",
  "resolveCommand",
  "probeHarnessCli",
  "pretrustWorkspaces",
  "verifyCodexHookTrust",
] as const;

export type CoreHomeOperation = (typeof CORE_HOME_OPERATIONS)[number];

/** What the helper is given, per operation. Everything is data. */
export type CoreHomeOpRequest =
  | {
      op: "installHarnessHooks";
      harness: string;
      cwd: string;
      /** `$PI_CODING_AGENT_DIR` of the spawn env, the one variable a writer follows. */
      piAgentDir: string | null;
    }
  | { op: "ensureStatuslineTap"; cwd: string }
  | { op: "ensureClaudeShiftEnterBinding" }
  | { op: "ensureOrchestrationSkill" }
  | { op: "wireLocalCore"; label: string; credential: RegistrationCredential }
  | { op: "spawnPathFacts"; cwd: string; roots: string[] }
  | { op: "resolveExecCwd"; cwd: string | null }
  /** `path` is the PATH to search; null is the helper's own (core's). */
  | { op: "resolveCommand"; command: string; path: string | null }
  /** Find a Harness CLI on `path` and run its `--version`, both as core. Same fields as `resolveCommand`. */
  | { op: "probeHarnessCli"; command: string; path: string | null }
  /** Record trust for `dirs` in each named Harness's own config (#685). */
  | { op: "pretrustWorkspaces"; harnesses: string[]; dirs: string[] }
  /** Ask the codex found on `path` (as `probeHarnessCli` finds it) whether it hashes this Core's hooks as this Core does (#703). */
  | { op: "verifyCodexHookTrust"; path: string | null };

export type RegistrationCredential = {
  endpoint: string;
  label: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  bearer: string;
};

export type SpawnPathFacts = {
  /** The cwd is a readable, enterable directory the helper may look at. */
  cwdOk: boolean;
  /** `realpath` of the cwd and of each root, or null: missing, unreadable or outside the home. */
  realpaths: Record<string, string | null>;
};

/** The answer type of each operation. */
export type CoreHomeOpResult = {
  installHarnessHooks: HookInstallResult;
  ensureStatuslineTap: null;
  ensureClaudeShiftEnterBinding: null;
  ensureOrchestrationSkill: SkillInstallEntry[];
  wireLocalCore: LocalCoreWiring;
  spawnPathFacts: SpawnPathFacts;
  resolveExecCwd: { cwd: string };
  /** Every executable match, in search order; the caller picks by version. */
  resolveCommand: { candidates: string[] };
  /**
   * Every match, and the one that meets the version floor (or the first, with its
   * failed check), already version-checked. `meeting` is null when there is no
   * match, and for a command with no registered version floor.
   */
  probeHarnessCli: { candidates: string[]; meeting: { binary: string; check: HarnessVersionCheck } | null };
  pretrustWorkspaces: PretrustResult[];
  /** The codex that was asked, the version it reported (null when unreadable), and what it said. */
  verifyCodexHookTrust: { binary: string; version: string | null; check: CodexHookTrustCheck };
};

/** Where and as whom the operations run. */
export type CoreHomeOpContext = {
  /** The home the operations work in: `core`'s. */
  home: string;
  /** Paths a request may name, or null for "no confinement" (outside the container). */
  roots: string[] | null;
  /** The env the registry location is read from (`XDG_CONFIG_HOME`). */
  env: NodeJS.ProcessEnv;
};

/** The request was not acceptable. Nothing was done. The helper exits 2. */
export class CoreHomeOpRefusedError extends Error {
  constructor(
    readonly code: "bad-json" | "bad-request" | "unknown-op" | "bad-field" | "path-escape" | "too-large",
    message: string,
  ) {
    super(message);
    this.name = "CoreHomeOpRefusedError";
  }
}

/** The request was fine and the operation failed; the message is the operator's. The helper exits 1. */
export class CoreHomeOpFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreHomeOpFailedError";
  }
}

// ─── request validation ──────────────────────────────────────────────

const MAX_PATH_LENGTH = 4096;
const MAX_ROOTS = 256;
const MAX_CREDENTIAL_FIELD = 64 * 1024;
const MAX_SEARCH_PATH_LENGTH = 16 * 1024;
const MAX_TRUST_DIRS = 16;

function refuse(code: CoreHomeOpRefusedError["code"], message: string): never {
  throw new CoreHomeOpRefusedError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, field: string, max = MAX_PATH_LENGTH, allowEmpty = false): string {
  if (typeof value !== "string" || (value.length === 0 && !allowEmpty) || value.length > max || value.includes("\0")) {
    refuse("bad-field", `${field} must be a${allowEmpty ? "" : " non-empty"} string of at most ${max} characters, with no NUL`);
  }
  return value;
}

function optionalStr(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : str(value, field);
}

function noExtraFields(req: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(req).filter((key) => key !== "op" && !allowed.includes(key));
  if (extra.length > 0) refuse("bad-request", `unexpected field${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}`);
}

/**
 * Turn what arrived on the wire into a request, or refuse it. The operation name
 * is matched against {@link CORE_HOME_OPERATIONS} first, so an unknown one never
 * reaches a field check, and unknown fields are refused rather than ignored: a
 * field nobody reads is a field somebody thinks is doing something.
 */
export function parseCoreHomeOpRequest(raw: unknown): CoreHomeOpRequest {
  if (!isRecord(raw)) refuse("bad-request", "the request must be a JSON object");
  const op = raw.op;
  if (typeof op !== "string" || !(CORE_HOME_OPERATIONS as readonly string[]).includes(op)) {
    refuse("unknown-op", `unknown operation ${JSON.stringify(typeof op === "string" ? op.slice(0, 64) : op)}`);
  }
  switch (op as CoreHomeOperation) {
    case "installHarnessHooks": {
      noExtraFields(raw, ["harness", "cwd", "piAgentDir"]);
      const harness = str(raw.harness, "harness", 32);
      if (!/^[a-z][a-z0-9-]*$/.test(harness)) refuse("bad-field", "harness is not a harness id");
      return { op: "installHarnessHooks", harness, cwd: str(raw.cwd, "cwd"), piAgentDir: optionalStr(raw.piAgentDir, "piAgentDir") };
    }
    case "ensureStatuslineTap":
      noExtraFields(raw, ["cwd"]);
      return { op: "ensureStatuslineTap", cwd: str(raw.cwd, "cwd") };
    case "ensureClaudeShiftEnterBinding":
      noExtraFields(raw, []);
      return { op: "ensureClaudeShiftEnterBinding" };
    case "ensureOrchestrationSkill":
      noExtraFields(raw, []);
      return { op: "ensureOrchestrationSkill" };
    case "wireLocalCore": {
      noExtraFields(raw, ["label", "credential"]);
      if (!isRecord(raw.credential)) refuse("bad-field", "credential must be an object");
      const c = raw.credential;
      noExtraFields({ op, ...c }, ["endpoint", "label", "caCert", "clientCert", "clientKey", "bearer"]);
      return {
        op: "wireLocalCore",
        // An empty label is a label: the registry falls back to a default name.
        label: str(raw.label, "label", 256, true),
        credential: {
          endpoint: str(c.endpoint, "credential.endpoint", 512),
          label: str(c.label, "credential.label", 256, true),
          caCert: str(c.caCert, "credential.caCert", MAX_CREDENTIAL_FIELD),
          clientCert: str(c.clientCert, "credential.clientCert", MAX_CREDENTIAL_FIELD),
          clientKey: str(c.clientKey, "credential.clientKey", MAX_CREDENTIAL_FIELD),
          bearer: str(c.bearer, "credential.bearer", MAX_CREDENTIAL_FIELD),
        },
      };
    }
    case "spawnPathFacts": {
      noExtraFields(raw, ["cwd", "roots"]);
      if (!Array.isArray(raw.roots) || raw.roots.length > MAX_ROOTS) {
        refuse("bad-field", `roots must be a list of at most ${MAX_ROOTS} paths`);
      }
      return {
        op: "spawnPathFacts",
        cwd: str(raw.cwd, "cwd"),
        roots: raw.roots.map((root, i) => str(root, `roots[${i}]`)),
      };
    }
    case "resolveExecCwd":
      noExtraFields(raw, ["cwd"]);
      return { op: "resolveExecCwd", cwd: optionalStr(raw.cwd, "cwd") };
    case "verifyCodexHookTrust":
      noExtraFields(raw, ["path"]);
      return {
        op: "verifyCodexHookTrust",
        path: raw.path === null || raw.path === undefined ? null : str(raw.path, "path", MAX_SEARCH_PATH_LENGTH),
      };
    case "pretrustWorkspaces": {
      noExtraFields(raw, ["harnesses", "dirs"]);
      if (!Array.isArray(raw.harnesses) || raw.harnesses.length > 8) refuse("bad-field", "harnesses must be a short list");
      if (!Array.isArray(raw.dirs) || raw.dirs.length > MAX_TRUST_DIRS) {
        refuse("bad-field", `dirs must be a list of at most ${MAX_TRUST_DIRS} paths`);
      }
      return {
        op: "pretrustWorkspaces",
        harnesses: raw.harnesses.map((h, i) => {
          const id = str(h, `harnesses[${i}]`, 32);
          if (!/^[a-z][a-z0-9-]*$/.test(id)) refuse("bad-field", "harnesses holds something that is not a harness id");
          return id;
        }),
        dirs: raw.dirs.map((dir, i) => str(dir, `dirs[${i}]`)),
      };
    }
    case "resolveCommand":
    case "probeHarnessCli": {
      noExtraFields(raw, ["command", "path"]);
      const command = str(raw.command, "command", 32);
      // A bare name, never a path: the lookup is a search of PATH, and a name with
      // a separator would make it a probe of any file the helper can see.
      if (!/^[a-z][a-z0-9-]*$/.test(command)) refuse("bad-field", "command is not a bare command name");
      return {
        op: op === "probeHarnessCli" ? "probeHarnessCli" : "resolveCommand",
        command,
        path: raw.path === null || raw.path === undefined ? null : str(raw.path, "path", MAX_SEARCH_PATH_LENGTH),
      };
    }
  }
}

// ─── confinement ─────────────────────────────────────────────────────

function within(child: string, root: string): boolean {
  return child === root || child.startsWith(root === path.sep ? root : root + path.sep);
}

/**
 * Is `resolved` (already normalised) still inside `root` once every link on the
 * way is followed? The part that does not exist yet is appended to the
 * `realpath` of the part that does, which is how a file the helper is about to
 * create is judged. A dangling link is refused: `writeFile` through it would
 * create its target, wherever that is.
 */
function realWithin(resolved: string, root: string): boolean {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return false;
  }
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return within(path.join(fs.realpathSync(current), ...missing), realRoot);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return false;
      try {
        if (fs.lstatSync(current).isSymbolicLink()) return false;
      } catch {
        /* nothing there at all: climb */
      }
      const parent = path.dirname(current);
      if (parent === current) return false;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** The normalised path, or null when it is outside what this context allows. */
function confined(p: string, ctx: CoreHomeOpContext): string | null {
  if (!ctx.roots) return p;
  if (!path.isAbsolute(p)) return null;
  const resolved = path.resolve(p);
  const root = ctx.roots.find((r) => within(resolved, r));
  return root && realWithin(resolved, root) ? resolved : null;
}

/** {@link confined}, or a refusal that names the field. */
function confine(p: string, ctx: CoreHomeOpContext, field: string): string {
  const result = confined(p, ctx);
  if (result === null) {
    refuse("path-escape", `${field} is not inside this Core's home (${ctx.roots?.join(", ")}): ${p.slice(0, 256)}`);
  }
  return result;
}

// ─── the operations ──────────────────────────────────────────────────

/**
 * Claude Code only treats ESC+CR (`\x1b\r`, what `terminal-keymap.ts` emits for
 * Shift+Enter) as "insert newline" when this flag is set. Normally `/terminal-
 * setup` writes it; do it eagerly so the user doesn't have to.
 */
function ensureShiftEnterBinding(home: string, ctx: CoreHomeOpContext): void {
  const dir = path.join(home, ".claude");
  const file = confine(path.join(dir, "settings.json"), ctx, "settings file");
  try {
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      if (raw.trim()) settings = JSON.parse(raw);
    }
    if (settings.shiftEnterKeyBindingInstalled === true) return;
    settings.shiftEnterKeyBindingInstalled = true;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch {
    // best-effort — user can still run `/terminal-setup` manually.
  }
}

const DEFAULT_CWD_FLAGS = fs.constants.R_OK | fs.constants.X_OK;

function isEnterableDirectory(p: string): boolean {
  try {
    if (!fs.statSync(p).isDirectory()) return false;
    fs.accessSync(p, DEFAULT_CWD_FLAGS);
    return true;
  } catch {
    return false;
  }
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}


/**
 * Run one operation that needs no `await`. Throws {@link CoreHomeOpRefusedError}
 * for a request that must not be run (nothing was done) and
 * {@link CoreHomeOpFailedError} for one that ran and could not finish.
 */
export function handleCoreHomeOpSync<Op extends CoreHomeOperation>(
  request: Extract<CoreHomeOpRequest, { op: Op }>,
  ctx: CoreHomeOpContext,
): CoreHomeOpResult[Op];
export function handleCoreHomeOpSync(request: CoreHomeOpRequest, ctx: CoreHomeOpContext): CoreHomeOpResult[CoreHomeOperation];
export function handleCoreHomeOpSync(request: CoreHomeOpRequest, ctx: CoreHomeOpContext): unknown {
  switch (request.op) {
    case "resolveCommand": {
      // A search of PATH is a read, so it is not confined to the home: the CLIs
      // are in `~/.local/bin` and in `/usr/local/bin`. What it can see is what
      // `core` can see, and it answers with paths only.
      const env = request.path === null ? ctx.env : { ...ctx.env, PATH: request.path };
      return { candidates: resolveAllHarnessCommandsOnPath(request.command, env, os.platform()) };
    }
    case "probeHarnessCli": {
      // The `--version` of each match is run here, by core, in a process the daemon
      // bounds and can kill. The daemon never runs a file core controls itself: its
      // `spawnSync` cannot be interrupted (it has no CAP_KILL for another uid), so a
      // wrapper whose `--version` hangs would hold its event loop.
      const env = request.path === null ? ctx.env : { ...ctx.env, PATH: request.path };
      const platform = os.platform();
      const candidates = resolveAllHarnessCommandsOnPath(request.command, env, platform);
      const requirement = HARNESS_CLI_CONFIG_BY_COMMAND[request.command];
      const meeting = requirement ? pickHarnessCandidateMeetingVersion(candidates, requirement, env, platform) : null;
      return { candidates, meeting };
    }
    case "installHarnessHooks": {
      const cwd = confine(request.cwd, ctx, "cwd");
      if (request.piAgentDir !== null) {
        confine(piAgentDir({ PI_CODING_AGENT_DIR: request.piAgentDir }, ctx.home), ctx, "piAgentDir");
      }
      const env = request.piAgentDir === null ? {} : { PI_CODING_AGENT_DIR: request.piAgentDir };
      // The files the writers will write, not just the directory they start from:
      // a linked `.claude` or `.codex` inside the workspace leads out of the home.
      const files = hookWritePaths(request.harness, cwd, env);
      for (const file of files) confine(file, ctx, "hook file");
      const installed = installHarnessHooks(request.harness, cwd, env);
      if (request.harness === "codex" && installed.installed) {
        // codex holds hooks it has not seen at a trust review. Answer it for the ones this Core just wrote, the way
        // codex records its own answer, so a Session never waits at it. Best-effort: the review is still answered by
        // the bypass flag where this Core earns it, and by hand otherwise.
        try {
          const config = confine(codexConfigPath(ctx.home), ctx, "codex config");
          for (const file of files) {
            const real = realpathOrNull(file);
            trustCodexHooks(config, ownedCodexHookTrust(file, real !== null && real !== file ? [file, real] : [file]));
          }
        } catch (err) {
          // Left to the review (and the bypass flag where earned); the reason goes to the caller's log.
          return { ...installed, hookTrustNote: err instanceof Error ? err.message : String(err) };
        }
      }
      return installed;
    }
    case "pretrustWorkspaces": {
      // Only directories inside the home, and only the two config files, each
      // confined like any other write: a link in the home that leaves it is refused.
      const dirs = new Set<string>();
      for (const dir of request.dirs) {
        const inside = confine(dir, ctx, "dir");
        dirs.add(inside);
        // Harnesses key a project by the path they were started in, which may be the
        // resolved one when the home is a link; trust both spellings.
        const real = realpathOrNull(inside);
        if (real !== null) dirs.add(real);
      }
      confine(claudeConfigPath(ctx.home), ctx, "claude config");
      confine(codexConfigPath(ctx.home), ctx, "codex config");
      for (const dir of dirs) confine(cursorMarkerPath(ctx.home, dir), ctx, "cursor trust marker");
      return pretrustWorkspaces(ctx.home, request.harnesses, [...dirs]);
    }
    case "ensureStatuslineTap": {
      const cwd = confine(request.cwd, ctx, "cwd");
      confine(path.join(cwd, ".claude", "settings.local.json"), ctx, "statusline settings file");
      confine(statuslineTapPath(ctx.home), ctx, "statusline tap script");
      ensureStatuslineTap(cwd);
      return null;
    }
    case "ensureClaudeShiftEnterBinding":
      ensureShiftEnterBinding(ctx.home, ctx);
      return null;
    case "ensureOrchestrationSkill":
      confine(ctx.home, ctx, "home");
      if (ctx.roots) for (const folder of orchestrationSkillFolders(ctx.home)) confine(folder, ctx, "skill folder");
      return installOrchestrationSkills(ctx.home);
    case "wireLocalCore": {
      const paths = registryPaths(ctx.env, ctx.home);
      for (const [field, p] of Object.entries(paths)) confine(p, ctx, `registry ${field}`);
      try {
        return wireLocalCore(paths, request.label, request.credential);
      } catch (err) {
        throw new CoreHomeOpFailedError(err instanceof Error ? err.message : String(err));
      }
    }
    case "spawnPathFacts": {
      // Looking is not refused, it just finds nothing: a path outside the home
      // is one this Core cannot run a Session in, and the policy on the
      // daemon's side drops a path whose answer is null.
      const facts: SpawnPathFacts = { cwdOk: false, realpaths: {} };
      const cwd = confined(request.cwd, ctx);
      facts.cwdOk = cwd !== null && isEnterableDirectory(cwd);
      for (const p of [request.cwd, ...request.roots]) {
        const inside = confined(p, ctx);
        facts.realpaths[p] = inside === null ? null : realpathOrNull(inside);
      }
      return facts;
    }
    case "resolveExecCwd": {
      const raw = request.cwd !== null && request.cwd.trim() ? request.cwd.trim() : ctx.home;
      const cwd = confined(raw, ctx);
      if (cwd === null) throw new CoreHomeOpFailedError(`Not inside this Core's home, so not a place a command can run: ${raw}`);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(cwd);
      } catch {
        throw new CoreHomeOpFailedError(`No such directory on this Core: ${raw}`);
      }
      if (!stat.isDirectory()) throw new CoreHomeOpFailedError(`Not a directory on this Core: ${raw}`);
      return { cwd: raw };
    }
    case "verifyCodexHookTrust":
      // Asynchronous (it waits on codex): `handleCoreHomeOp` runs it; the helper and the client both go through that.
      throw new CoreHomeOpFailedError("verifyCodexHookTrust runs through handleCoreHomeOp");
  }
}

/** Where the check's throwaway workspace and `CODEX_HOME` are made: under the home, so codex's writes stay in it. */
export function codexHookCheckRoot(home: string): string {
  return path.join(home, ".cache", "actana");
}

/**
 * The `verifyCodexHookTrust` op (#703): find codex the way `probeHarnessCli` does (a search of PATH, never a path
 * from the request), and ask it to list this Core's hooks from a throwaway workspace (`codex-hook-trust-check.ts`).
 * The binary and the version come from the same resolution as the availability probe, so what is checked is what
 * a Session gets.
 */
async function verifyCodexHookTrust(
  request: Extract<CoreHomeOpRequest, { op: "verifyCodexHookTrust" }>,
  ctx: CoreHomeOpContext,
): Promise<CoreHomeOpResult["verifyCodexHookTrust"]> {
  const env = request.path === null ? ctx.env : { ...ctx.env, PATH: request.path };
  const platform = os.platform();
  const requirement = HARNESS_CLI_CONFIG_BY_COMMAND.codex;
  const candidates = resolveAllHarnessCommandsOnPath("codex", env, platform);
  const meeting = requirement ? pickHarnessCandidateMeetingVersion(candidates, requirement, env, platform) : null;
  if (!meeting) throw new CoreHomeOpFailedError("codex is not on this Core's PATH");
  const root = confine(codexHookCheckRoot(ctx.home), ctx, "check directory");
  let check: CodexHookTrustCheck;
  try {
    check = await checkCodexHookTrust(meeting.binary, root, env);
  } catch (err) {
    throw new CoreHomeOpFailedError(err instanceof Error ? err.message : String(err));
  }
  const version = (meeting.check as { version?: unknown }).version;
  return { binary: meeting.binary, version: typeof version === "string" ? version : null, check };
}

/** {@link handleCoreHomeOpSync}, as a promise: the helper's entry and the in-process client both `await` it. */
export async function handleCoreHomeOp<Op extends CoreHomeOperation>(
  request: Extract<CoreHomeOpRequest, { op: Op }>,
  ctx: CoreHomeOpContext,
): Promise<CoreHomeOpResult[Op]>;
export async function handleCoreHomeOp(request: CoreHomeOpRequest, ctx: CoreHomeOpContext): Promise<unknown> {
  if (request.op === "verifyCodexHookTrust") return verifyCodexHookTrust(request, ctx);
  return handleCoreHomeOpSync(request, ctx);
}
