/**
 * Local "who is signed in" detection for the managed Harnesses. Reads only
 * the auth files each CLI already writes; the returned identifier is a
 * display value (email / account id / user id) — tokens never leave here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Harness } from "@actana/shared/domain";
import { MANAGED_HARNESSES } from "@actana/shared/harness-cli-config";
import { piAgentDir } from "@actana/shared/pi-agent-dir";
import type { HarnessAccountStatus } from "~/shared/harness-launchers";
import { readCodexOAuthCredentials } from "./provider-usage/codex-usage";
import { readCursorUserId } from "./provider-usage/cursor-usage";

export type { HarnessAccountStatus } from "~/shared/harness-launchers";

let homeDir: () => string = os.homedir;
let codexReader: () => { accountId: string | null } | null = readCodexOAuthCredentials;
let cursorReader: () => string | null = readCursorUserId;

function readClaudeAccount(): HarnessAccountStatus {
  // ~/.claude.json also holds per-project caches and can be several MB, so no
  // size cap here — just tolerate parse failures.
  try {
    const raw = fs.readFileSync(path.join(homeDir(), ".claude.json"), "utf8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    const account =
      json.oauthAccount && typeof json.oauthAccount === "object"
        ? (json.oauthAccount as Record<string, unknown>)
        : null;
    if (!account) return { agent: "claude-code", connected: false, identifier: null };
    const email =
      typeof account.emailAddress === "string" && account.emailAddress.trim()
        ? account.emailAddress.trim()
        : null;
    return { agent: "claude-code", connected: true, identifier: email };
  } catch {
    return { agent: "claude-code", connected: false, identifier: null };
  }
}

function readCodexAccount(): HarnessAccountStatus {
  try {
    const creds = codexReader();
    if (!creds) return { agent: "codex", connected: false, identifier: null };
    return { agent: "codex", connected: true, identifier: creds.accountId };
  } catch {
    return { agent: "codex", connected: false, identifier: null };
  }
}

function readCursorAccount(): HarnessAccountStatus {
  try {
    const userId = cursorReader();
    return { agent: "cursor-cli", connected: userId !== null, identifier: userId };
  } catch {
    return { agent: "cursor-cli", connected: false, identifier: null };
  }
}

function readOpenCodeAccount(): HarnessAccountStatus {
  try {
    const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(homeDir(), ".local", "share");
    const connected = fs.existsSync(path.join(dataHome, "opencode", "auth.json"));
    return { agent: "opencode", connected, identifier: null };
  } catch {
    return { agent: "opencode", connected: false, identifier: null };
  }
}

/**
 * Provider API-key environment variables Pi resolves (see
 * `@earendil-works/pi-ai` `env-api-keys` / Pi providers docs). Presence of any
 * non-empty value counts as a credential even when `auth.json` is empty.
 */
const PI_PROVIDER_API_KEY_ENVS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "OPENCODE_API_KEY",
  "RADIUS_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "BASETEN_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "COPILOT_GITHUB_TOKEN",
] as const;

/** True when `auth.json` holds at least one provider credential (api_key or oauth). */
function hasPiStoredLogin(): boolean {
  try {
    const raw = fs.readFileSync(path.join(piAgentDir(process.env, homeDir()), "auth.json"), "utf8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    return Object.values(json).some((entry) => entry !== null && typeof entry === "object");
  } catch {
    return false;
  }
}

function hasPiProviderApiKeyEnv(): boolean {
  return PI_PROVIDER_API_KEY_ENVS.some((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function readPiAccount(): HarnessAccountStatus {
  // Pi credentials are either a stored login under `~/.pi/agent/auth.json`
  // (after `/login`) or a provider API-key environment variable. The mere
  // existence of `~/.pi` (created on first run with an empty auth.json) is
  // not enough. No single display identifier is published the way Claude's
  // email or Cursor's user id are.
  try {
    const connected = hasPiStoredLogin() || hasPiProviderApiKeyEnv();
    return { agent: "pi", connected, identifier: null };
  } catch {
    return { agent: "pi", connected: false, identifier: null };
  }
}

export function readHarnessAccounts(): HarnessAccountStatus[] {
  const byHarness: Record<Harness, () => HarnessAccountStatus> = {
    "claude-code": readClaudeAccount,
    codex: readCodexAccount,
    "cursor-cli": readCursorAccount,
    opencode: readOpenCodeAccount,
    pi: readPiAccount,
  };
  return MANAGED_HARNESSES.map((agent) => byHarness[agent]());
}

export function _setHarnessAccountsDepsForTests(deps: {
  homeDir?: (() => string) | null;
  codexReader?: (() => { accountId: string | null } | null) | null;
  cursorReader?: (() => string | null) | null;
}): void {
  if (deps.homeDir !== undefined) homeDir = deps.homeDir ?? os.homedir;
  if (deps.codexReader !== undefined) codexReader = deps.codexReader ?? readCodexOAuthCredentials;
  if (deps.cursorReader !== undefined) cursorReader = deps.cursorReader ?? readCursorUserId;
}
