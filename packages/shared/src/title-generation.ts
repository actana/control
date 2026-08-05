// The pure half of session title generation — the meta-prompt, which CLI to
// invoke for a given harness, and how to read what comes back.
//
// Two hosts run it now (issue 84): the Core, for the Sessions it owns and the
// harness binaries only it has, and the Panel, for its own remaining local
// rows. Only the writes differ, so only the writes live outside this file.

import { HARNESS_REGISTRY } from "./harnesses";
import type { Harness } from "./domain";
import { SESSION_ICON_OPTIONS, isSessionIcon } from "./session-icons";

/**
 * Leading sentence of the title meta-prompt. Exported (via
 * {@link isTitleGenerationPrompt}) so the hook pipeline can recognize — and
 * ignore — a title-generation helper that fired Actana Control's own hooks,
 * a defense-in-depth backstop against the recording/recursion feedback loop.
 */
const TITLE_PROMPT_SIGNATURE = "You are naming a developer's coding session.";

/** True when `text` is (the start of) our internal title-generation prompt. */
export function isTitleGenerationPrompt(text: string): boolean {
  return text.trimStart().startsWith(TITLE_PROMPT_SIGNATURE);
}

/**
 * Print-mode CLI invocations (claude -p, cursor-agent -p, codex exec) are
 * unreliable about emitting strict JSON when the surrounding prompt is large.
 * Asking for a two-line key:value format ("TITLE: …" / "ICON: …") is far more
 * compliant: the model produces it almost verbatim, the parser is trivial, and
 * we can still fall back to JSON or last-line plaintext if the model improvises.
 */
function buildMetaPrompt(): string {
  const iconList = SESSION_ICON_OPTIONS.map((o) => `- ${o.id} (${o.hint})`).join("\n");
  return [
    `${TITLE_PROMPT_SIGNATURE} Pick a short title and a matching icon.`,
    "",
    "Reply with EXACTLY two lines and nothing else:",
    "TITLE: <4 to 7 words, plain text, no quotes, no trailing punctuation>",
    "ICON: <one id from the allowed list below>",
    "",
    "Examples:",
    "",
    "Task: Refactor the auth middleware to use JWT instead of session cookies.",
    "TITLE: Switch auth from cookies to JWT",
    "ICON: shield-check",
    "",
    "Task: The login page is broken when clicking submit twice quickly.",
    "TITLE: Fix double-submit on login button",
    "ICON: bug",
    "",
    "Task: Add a dark mode toggle to the settings panel.",
    "TITLE: Add dark mode toggle",
    "ICON: palette",
    "",
    "Task: Migrate the users table to add an email_verified column.",
    "TITLE: Add email-verified column to users",
    "ICON: database",
    "",
    "Allowed icon ids:",
    iconList,
    "",
    "Now do the real task. Respond with TITLE: and ICON: on two lines.",
    "",
    "Task: ",
  ].join("\n");
}

const META_PROMPT = buildMetaPrompt();

// Spawning cursor-agent -p while an interactive cursor-agent PTY is active can
// destabilize the running session and crash the Panel service (EPIPE).
const CURSOR_TITLE_CLI_FALLBACKS: Harness[] = ["claude-code", "codex"];

export function resolveTitleInvocation(
  agent: Harness,
  prompt: string,
): { cmd: string; args: string[] } | undefined {
  const input = META_PROMPT + prompt;
  if (agent !== "cursor-cli") {
    return HARNESS_REGISTRY[agent].titleInvocation?.(input);
  }
  for (const fallbackHarness of CURSOR_TITLE_CLI_FALLBACKS) {
    const invocation = HARNESS_REGISTRY[fallbackHarness].titleInvocation?.(input);
    if (invocation) return invocation;
  }
  return undefined;
}

export type Parsed = { title: string; icon: string | null };

/**
 * Walk the string from the end and yield every balanced `{…}` block as a
 * candidate JSON payload. CLIs (especially codex exec) often print preamble or
 * diagnostic text that may itself contain stray `{`/`}` — a single greedy regex
 * would match across them and fail to parse. Returning the right-most balanced
 * block first matches where the final answer typically lives.
 */
function* candidateJsonBlocks(s: string): Generator<string> {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] !== "}") continue;
    let depth = 0;
    for (let j = i; j >= 0; j--) {
      const ch = s[j];
      if (ch === "}") depth++;
      else if (ch === "{") {
        depth--;
        if (depth === 0) {
          yield s.slice(j, i + 1);
          break;
        }
      }
    }
  }
}

const TITLE_MAX_WORDS = 7;
const TITLE_MAX_LEN = 80;
const FALLBACK_TITLE_MAX_LEN = 60;
const ANSI_ESCAPE_REGEX =
  /(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[PX^_].*?(?:\x1b\\)|\x1b[@-_])/g;
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const ORPHANED_TERMINAL_RGB_RESPONSE_REGEX =
  /(?:\]?\d{1,2};)?rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}/g;

export function stripTerminalControlText(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(ORPHANED_TERMINAL_RGB_RESPONSE_REGEX, "")
    .replace(CONTROL_CHARS_REGEX, "");
}

function sanitizeTitle(raw: string): string {
  let t = stripTerminalControlText(raw).trim();
  t = t.replace(/^["'`]+|["'`]+$/g, "");
  t = t.replace(/[.!?,;:]+$/g, "");
  const words = t.split(/\s+/).filter(Boolean).slice(0, TITLE_MAX_WORDS);
  t = words.join(" ");
  if (t.length > TITLE_MAX_LEN) t = t.slice(0, TITLE_MAX_LEN).trim();
  return t;
}

function tryKeyValueFormat(raw: string): Parsed | null {
  // Match the LAST TITLE: / ICON: lines so any preamble or repeated examples
  // can't shadow the real answer.
  const titleMatches = [...raw.matchAll(/^\s*TITLE\s*[:=]\s*(.+?)\s*$/gim)];
  const iconMatches = [...raw.matchAll(/^\s*ICON\s*[:=]\s*([a-z0-9-]+)\s*$/gim)];
  const titleRaw = titleMatches.length ? titleMatches[titleMatches.length - 1]![1] : "";
  const iconRaw = iconMatches.length ? iconMatches[iconMatches.length - 1]![1] : "";

  const title = sanitizeTitle(titleRaw);
  if (!title) return null;
  const icon = isSessionIcon(iconRaw) ? iconRaw : null;
  return { title, icon };
}

function tryJsonFormat(raw: string): Parsed | null {
  const unfenced = raw.replace(/^```[a-zA-Z]*\s*|\s*```$/g, "").trim();
  for (const block of candidateJsonBlocks(unfenced)) {
    try {
      const obj = JSON.parse(block);
      const title = typeof obj?.title === "string" ? sanitizeTitle(obj.title) : "";
      if (!title) continue;
      const icon = isSessionIcon(obj?.icon) ? obj.icon : null;
      return { title, icon };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function parseResponse(raw: string): Parsed {
  const trimmed = stripTerminalControlText(raw).trim();

  // Primary format: the one we ask for.
  const kv = tryKeyValueFormat(trimmed);
  if (kv) return kv;

  // Backstop: if the model decided to return JSON anyway, accept it.
  const json = tryJsonFormat(trimmed);
  if (json) return json;

  // Last-ditch: assume the model returned a bare one-line title.
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return { title: sanitizeTitle(last), icon: null };
}

export function fallbackTitle(prompt: string): string {
  const cleanPrompt = stripTerminalControlText(prompt);
  const firstLine = cleanPrompt.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "Untitled task";
  return firstLine.length > FALLBACK_TITLE_MAX_LEN
    ? firstLine.slice(0, FALLBACK_TITLE_MAX_LEN).trim() + "…"
    : firstLine;
}
