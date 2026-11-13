import { classifyDialog, type DialogKind, type DialogOption } from "@actana/shared/harness-dialog-classifier";
import { renderScreenText } from "@actana/shared/screen-text";

/**
 * What a Task whose Session waits at a prompt asks, and what an answer to it types (#959). Pure: the screen and the hook's
 * hint go in, the prompt or the bytes for the PTY come out. The reading of a Core's PTY and the writing of the answer are
 * `task-answer.ts`.
 */

export type TaskPromptKind = DialogKind;
export type TaskPromptOption = DialogOption;

/** Where `kind` and `options` came from: a hook that set `needs-input`, or the screen (`classifyDialog`, or nothing: `unknown`). */
export type TaskPromptSource = "hook" | "screen";

export type TaskPrompt = {
  /** The visible prompt: the last lines of the screen, at most {@link PROMPT_TEXT_MAX} characters, secrets masked. */
  text: string;
  options?: TaskPromptOption[];
  kind: TaskPromptKind;
  /** The prompt's own name for the record: the hook's text, else the first line with a letter of the region the rules matched. */
  title?: string;
  /** What the rules read the screen as (`classifyDialog`), whatever the hook said: a `permission` screen stays an approval. */
  screenKind?: TaskPromptKind;
  /** When the Task's Session went to `needs-input` (ms): the id of this prompt, for `expect`. */
  at: number;
  source: TaskPromptSource;
};

/** What the hook that set `needs-input` said about the dialog (the Core's `session:prompt` event). */
export type HookPromptHint = {
  kind: "question" | "choice" | "permission";
  /** The tool a permission is asked for. */
  tool?: string;
  /** The question's text, from `AskUserQuestion`. */
  text?: string;
  /** The question's options, from `AskUserQuestion`. */
  options?: { label: string }[];
};

export const PROMPT_TEXT_MAX = 4096;
/** The screen's tail read when no rule recognises the dialog. */
const UNKNOWN_TAIL_LINES = 30;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[masked]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[masked]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[masked]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[masked]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[masked]"],
  [/\b((?:password|passwd|passphrase|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1[masked]"],
];

/** Secrets masked the way a prompt may be shown: key shapes, bearer tokens and `password=…`. */
export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((out, [re, to]) => out.replace(re, to), text);
}

/** The screen's last lines as text: a raw terminal stream (anything with an escape) is replayed onto a screen first. */
function tailText(screen: string): string {
  const rendered = screen.includes("\u001b") ? renderScreenText(screen) : screen.replace(/\r\n?/g, "\n");
  const lines = rendered
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "")
    .slice(-UNKNOWN_TAIL_LINES);
  return lines.join("\n");
}

/** The text's last {@link PROMPT_TEXT_MAX} UTF-8 bytes, not starting in the middle of a character. */
function cap(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= PROMPT_TEXT_MAX) return text;
  let start = bytes.length - PROMPT_TEXT_MAX;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

const BOX_BORDERS = /[│┃]/g;
/** A line that is an option of a dialog: a cursor marker, or a numbered choice. */
const OPTION_LINE = /^\s*(?:[›❯→>]|\d+[.)]\s)/;

const plainLine = (line: string): string => line.replace(BOX_BORDERS, " ").trim();

/**
 * What a dialog asks, for the record: the first line with a letter of the region the rules matched (box borders stripped).
 * A region that starts at its first option (Codex's `after-last-prompt-marker`) has not got the question: that is the
 * nearest line above it, in the screen's tail, that ends in `?` or `:`.
 */
function regionTitle(region: string, tailLines: readonly string[] = []): string | undefined {
  const lines = region.split("\n");
  const at = lines.findIndex((l) => /\p{L}/u.test(plainLine(l)));
  if (at < 0) return undefined;
  const first = plainLine(lines[at]!);
  if (OPTION_LINE.test(first)) {
    const start = tailLines.map(plainLine).lastIndexOf(first);
    for (let i = start - 1; i >= 0; i--) {
      const above = plainLine(tailLines[i]!);
      if (/\p{L}/u.test(above) && /[?:]$/.test(above)) return maskSecrets(above);
    }
  }
  return maskSecrets(first);
}

/**
 * The prompt a screen shows. Sources of `kind` and `options`, in this order: the hook (`hook`), `classifyDialog`, neither
 * (`unknown`, text only). A screen the rules read as a trust dialog is `trust` whatever the hook said: the one kind the
 * orchestrator never answers is never read as another.
 */
export function buildTaskPrompt(input: { harness: string; screen: string; hook: HookPromptHint | null; at: number }): TaskPrompt {
  const { harness, screen, hook, at } = input;
  const hit = classifyDialog(harness, screen);
  // The text is the screen's tail, not the matched rule's region: the question sits above the choices a rule reads.
  const tail = tailText(screen);
  const shown = (fallback = ""): string => cap(maskSecrets(tail || fallback));
  const hookTitle = hook?.text ? regionTitle(hook.text) : undefined;
  const title = hookTitle ?? (hit ? regionTitle(hit.text, tail.split("\n")) : undefined);
  const named = { ...(title !== undefined ? { title } : {}), ...(hit ? { screenKind: hit.kind } : {}) };
  if (hit?.kind === "trust") return { text: shown(hit.text), kind: "trust", at, source: hook ? "hook" : "screen", ...named, ...(hit.options ? { options: hit.options } : {}) };
  if (hook) {
    const hookOptions = hook.options?.length ? hook.options.map((o, i) => ({ label: o.label, key: String(i + 1) })) : undefined;
    const options = hookOptions ?? hit?.options;
    return { text: shown(hook.text), kind: hook.kind, at, source: "hook", ...named, ...(options ? { options } : {}) };
  }
  if (hit) return { text: shown(hit.text), kind: hit.kind, at, source: "screen", ...named, ...(hit.options ? { options: hit.options } : {}) };
  return { text: shown(), kind: "unknown", at, source: "screen" };
}

export type TaskAnswer = { text: string } | { option: number | string } | { keys: string[] };

export type AnswerPlan =
  | { ok: true; bytes: string; summary: string }
  | { ok: false; code: "invalid_answer" | "needs_human"; message: string };

/** The keys an answer may press, and the bytes a terminal sends for them. */
export const ANSWER_KEYS: Readonly<Record<string, string>> = {
  Enter: "\r",
  Esc: "\u001b",
  Up: "\u001b[A",
  Down: "\u001b[B",
  Right: "\u001b[C",
  Left: "\u001b[D",
  Tab: "\t",
  Space: " ",
  y: "y",
  Y: "Y",
  n: "n",
  N: "N",
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), String(i + 1)])),
};
export const ANSWER_KEY_NAMES = Object.keys(ANSWER_KEYS);
export const ANSWER_KEYS_MAX = 16;
export const ANSWER_TEXT_MAX = 1000;

const SECRET_PROMPT = /\b(?:pass(?:word|wd|phrase|code)|tokens?|credentials?|api[ _-]?keys?|secrets?|otp|2fa|one-time (?:code|password))\b/i;
/** Text that says a dialog asks to approve something, whatever kind the rules gave it. */
const PERMISSION_TEXT = /\b(?:allow|approve|approval|permission|grant)\b|run the following command|do you want to proceed/i;
/** An option that approves for longer than this once. */
const WIDENING_LABEL = /don'?t ask again|always allow|allow all|for (?:this|the rest of the) session|bypass|full access|dangerously/i;
const TRUST_TEXT = /\btrust\b/i;
const DECLINE_LABEL = /^\s*(?:no\b|deny\b|decline\b|reject\b|cancel\b|don'?t\b)/i;
/** A label that declines: "No", "Don't do it", but never one that widens ("Don't ask again"). */
const isDeclineLabel = (label: string): boolean => DECLINE_LABEL.test(label) && !WIDENING_LABEL.test(label);
const DECLINE_KEYS = new Set(["Esc", "n", "N"]);

const refuse = (code: "invalid_answer" | "needs_human", message: string): AnswerPlan => ({ ok: false, code, message });

const needsHuman = (what: string): AnswerPlan =>
  refuse("needs_human", `${what}: the orchestrator does not answer it. Ask a human, then let them answer it in the Session.`);

function optionIndexOf(options: TaskPromptOption[], wanted: number | string): number {
  if (typeof wanted === "number") return Number.isInteger(wanted) && wanted >= 1 && wanted <= options.length ? wanted - 1 : -1;
  const by = wanted.trim().toLowerCase();
  if (/^\d+$/.test(by)) return optionIndexOf(options, Number(by));
  return options.findIndex((o) => o.label.trim().toLowerCase() === by);
}

/** The bytes that choose option `at`: its number where the screen names one, else the arrow keys from the cursor row, then Enter. */
function chooseBytes(options: TaskPromptOption[], at: number): string {
  const key = options[at]!.key;
  if (key !== undefined) return key;
  const from = Math.max(0, options.findIndex((o) => o.selected));
  const steps = at - from;
  return `${(steps >= 0 ? ANSWER_KEYS.Down! : ANSWER_KEYS.Up!).repeat(Math.abs(steps))}${ANSWER_KEYS.Enter}`;
}

/** Is a permission answer a decline? Approving widens the Agent's access beyond what it was configured with. */
function declines(prompt: TaskPrompt, answer: TaskAnswer): boolean {
  if ("keys" in answer) {
    return answer.keys.every((k) => {
      if (DECLINE_KEYS.has(k)) return true;
      const picked = /^[1-9]$/.test(k) ? prompt.options?.find((o) => o.key === k) : undefined;
      return picked !== undefined && isDeclineLabel(picked.label);
    });
  }
  if ("option" in answer && prompt.options) {
    const at = optionIndexOf(prompt.options, answer.option);
    return at >= 0 && isDeclineLabel(prompt.options[at]!.label);
  }
  return false;
}

/**
 * Is this prompt an approval? Decided from the prompt, never from the answer: the kind, what the rules read the screen as
 * (a hook's `question`/`choice` does not hide it), its wording, or any option that widens access ("don't ask again").
 */
function isApproval(prompt: TaskPrompt): boolean {
  return (
    prompt.kind === "permission" ||
    prompt.screenKind === "permission" ||
    PERMISSION_TEXT.test(prompt.text) ||
    (prompt.options?.some((o) => WIDENING_LABEL.test(o.label)) ?? false)
  );
}

/** What an answer types into the prompt it was read for, or why it is refused. Nothing is typed by this function. */
export function planAnswer(prompt: TaskPrompt, answer: TaskAnswer): AnswerPlan {
  if (prompt.kind === "trust") return needsHuman("this prompt asks to trust a folder");
  if (SECRET_PROMPT.test(prompt.text)) return needsHuman("this prompt asks for a password, token or credential");
  if (prompt.kind === "unknown" && TRUST_TEXT.test(prompt.text)) return needsHuman("this prompt may ask to trust a folder");
  // Approvals are not always `permission`: Codex and generic dialogs say `choice` or `confirm`. Judged from the prompt alone.
  const approval = isApproval(prompt);

  if ("keys" in answer) {
    const { keys } = answer;
    if (keys.length === 0 || keys.length > ANSWER_KEYS_MAX) return refuse("invalid_answer", `keys takes 1 to ${ANSWER_KEYS_MAX} keys`);
    const bad = keys.find((k) => !Object.hasOwn(ANSWER_KEYS, k));
    if (bad !== undefined) return refuse("invalid_answer", `key ${JSON.stringify(bad)} is not allowed; the keys are ${ANSWER_KEY_NAMES.join(", ")}`);
    if (approval && !declines(prompt, answer)) {
      return needsHuman("approving this permission would widen the Agent's access; only a decline (Esc, n or a No option) is answered");
    }
    return { ok: true, bytes: keys.map((k) => ANSWER_KEYS[k]).join(""), summary: `keys [${keys.join(", ")}]` };
  }

  if (prompt.kind === "unknown") return refuse("invalid_answer", "this prompt is not recognised: answer it with { keys } only");

  if ("option" in answer) {
    if (!prompt.options?.length) return refuse("invalid_answer", "this prompt has no options: answer it with { text } or { keys }");
    const at = optionIndexOf(prompt.options, answer.option);
    if (at < 0) return refuse("invalid_answer", `there is no option ${JSON.stringify(answer.option)}; options are numbered 1 to ${prompt.options.length}`);
    if (approval && !declines(prompt, answer)) {
      return needsHuman("approving this permission would widen the Agent's access; only a decline (Esc, n or a No option) is answered");
    }
    return { ok: true, bytes: chooseBytes(prompt.options, at), summary: `option ${at + 1} ${JSON.stringify(prompt.options[at]!.label)}` };
  }

  // A text answer is never a recognised decline: on an approval it is refused, whatever the prompt's kind.
  if (approval) return needsHuman("approving this permission would widen the Agent's access; only a decline (Esc, n or a No option) is answered, with { keys } or { option }");
  if (prompt.kind !== "question" && prompt.kind !== "choice") {
    return refuse("invalid_answer", `a ${prompt.kind} prompt takes { option } or { keys }, not { text }`);
  }
  const { text } = answer;
  if (text.length === 0 || text.length > ANSWER_TEXT_MAX || /[\u0000-\u001f\u007f]/.test(text)) {
    return refuse("invalid_answer", `text is one line of 1 to ${ANSWER_TEXT_MAX} characters with no control characters`);
  }
  return { ok: true, bytes: `${text}${ANSWER_KEYS.Enter}`, summary: JSON.stringify(text) };
}
