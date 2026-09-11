import * as os from "node:os";
import {
  getAiRuntimeModelOptions,
  isAiModelId,
  type AiModelOption,
  type Harness,
  type AiRuntimeModelsResponse,
} from "@actana/shared/ai-runtime-defaults";
import { runCli } from "./claude-cli";

const MODEL_LIST_TIMEOUT_MS = 8_000;
const MODEL_LIST_CACHE_TTL_MS = 60_000;
const cache = new Map<
  Harness,
  { expiresAt: number; response: AiRuntimeModelsResponse }
>();
const inFlight = new Map<Harness, Promise<AiRuntimeModelsResponse>>();

export function clearAiRuntimeModelCache(): void {
  cache.clear();
  inFlight.clear();
}

function dedupeModels(models: AiModelOption[]): AiModelOption[] {
  const seen = new Set<string>();
  const out: AiModelOption[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

export function parseCursorModelList(raw: string): AiModelOption[] {
  return dedupeModels(
    raw
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\S+)\s+-\s+(.+)$/);
        if (!match) return null;
        const [, id, label] = match;
        if (!id || !label || !isAiModelId(id)) return null;
        return { id, label: label.trim() };
      })
      .filter((model): model is AiModelOption => model !== null),
  );
}

export function parsePlainModelList(raw: string): AiModelOption[] {
  return dedupeModels(
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter(isAiModelId)
      .map((id) => ({ id, label: id })),
  );
}

/** The thinking and images columns of a `pi --list-models` row. */
const PI_FLAG_COLUMN = /^(yes|no)$/;

/**
 * Parse `pi --list-models` padded table output.
 *
 * Upstream (`dist/cli/list-models.js`) prints a header row
 * (`provider  model  context  max-out  thinking  images`) then one row per
 * model. Columns are `padEnd`'d and joined with two spaces; when a column is
 * at full width the gap is still at least one whitespace token. A model row
 * is exactly six tokens whose last two — thinking and images — are `yes` or
 * `no`. That one test drops the header and every line of prose Pi prints on
 * stdout in place of a table ("No models available. Use /login …", "No models
 * matching …"), which a token count alone lets through. The first two tokens
 * are provider and model id — the form `pi --model` accepts is `provider/id`
 * (model ids may themselves contain `/`, e.g. OpenRouter).
 * {@link parsePlainModelList} cannot keep these lines because they contain
 * spaces.
 */
export function parsePiModelList(raw: string): AiModelOption[] {
  return dedupeModels(
    raw
      .split("\n")
      .map((line) => {
        const tokens = line.trim().split(/\s+/);
        if (tokens.length !== 6 || !tokens.slice(4).every((t) => PI_FLAG_COLUMN.test(t))) {
          return null;
        }
        const id = `${tokens[0]}/${tokens[1]}`;
        return isAiModelId(id) ? { id, label: id } : null;
      })
      .filter((model): model is AiModelOption => model !== null),
  );
}

function redactDiscoveryError(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "sk-<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{12,}/gi, "Bearer <redacted>")
    .replace(/([?&](?:token|api_key|access_token|key)=)[^&\s"']+/gi, "$1<redacted>");
}

async function liveModelOptions(
  harness: Harness,
): Promise<AiModelOption[] | null> {
  switch (harness) {
    case "cursor-cli": {
      const raw = await runCli("cursor-agent", ["--list-models"], {
        cwd: os.tmpdir(),
        timeoutMs: MODEL_LIST_TIMEOUT_MS,
      });
      return parseCursorModelList(raw);
    }
    case "opencode": {
      const raw = await runCli("opencode", ["models"], {
        cwd: os.tmpdir(),
        timeoutMs: MODEL_LIST_TIMEOUT_MS,
      });
      return parsePlainModelList(raw);
    }
    case "pi": {
      const raw = await runCli("pi", ["--list-models"], {
        cwd: os.tmpdir(),
        timeoutMs: MODEL_LIST_TIMEOUT_MS,
      });
      return parsePiModelList(raw);
    }
    case "claude-code":
    case "codex":
      return null;
  }
}

export async function listAiRuntimeModels(
  harness: Harness,
): Promise<AiRuntimeModelsResponse> {
  const cached = cache.get(harness);
  if (cached && cached.expiresAt > Date.now()) return cached.response;
  const running = inFlight.get(harness);
  if (running) return running;

  const promise = loadAiRuntimeModels(harness);
  inFlight.set(harness, promise);
  try {
    const response = await promise;
    cache.set(harness, {
      expiresAt: Date.now() + MODEL_LIST_CACHE_TTL_MS,
      response,
    });
    return response;
  } finally {
    inFlight.delete(harness);
  }
}

async function loadAiRuntimeModels(
  harness: Harness,
): Promise<AiRuntimeModelsResponse> {
  const catalog = [...getAiRuntimeModelOptions(harness)];
  try {
    const live = await liveModelOptions(harness);
    if (live?.length) {
      return { harness, source: "cli", models: live };
    }
  } catch (error) {
    console.warn(
      `[ai-runtime-models] ${harness} discovery failed: ${
        error instanceof Error
          ? redactDiscoveryError(error.message)
          : redactDiscoveryError(String(error))
      }`,
    );
    return {
      harness,
      source: "catalog",
      models: catalog,
      error: "model discovery failed",
    };
  }
  return { harness, source: "catalog", models: catalog };
}
