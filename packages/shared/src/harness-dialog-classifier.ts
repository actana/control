// Is the harness parked on a dialog? One pure function, rules as data (issue 963).
//
// `classifyDialog(harness, screenText)` reads a harness's screen and says which
// rule it matches, what kind of dialog that is and what the options are, or
// `null`. It tries the harness's own rules by priority, then `generic`. A
// harness's rules are never applied to another harness (the same reason the
// Core's interrupt screens are per harness): a Claude dialog printed inside a
// Codex Session is text, not a dialog. It reads only each rule's region, never
// the scrollback, so text the agent merely printed higher up does not match.
//
// The rules are in `./harness-dialog-rules/`. This file is the whole engine and
// knows no harness by name.

import { isHarness } from "./domain";
import {
  DEFAULT_REGION_LINES,
  GENERIC_DIALOG_RULES,
  HARNESS_DIALOG_RULES,
  type DialogKind,
  type DialogMatch,
  type DialogOption,
  type DialogRegion,
  type DialogRule,
} from "./harness-dialog-rules";
import { renderScreenText } from "./screen-text";

export type { DialogKind, DialogOption } from "./harness-dialog-rules";

export type DialogClassification = {
  ruleId: string;
  kind: DialogKind;
  /** The dialog's text: the rule's region, trimmed and capped. */
  text: string;
  options?: DialogOption[];
};

/** The longest `text` returned, keeping the end of the region (where the footer is). */
const MAX_TEXT_CHARS = 2000;

// A rule line, plain or carrying a name (`──── api ────`): it starts with a run of box-drawing dashes.
const HORIZONTAL_RULE = /^\s*[─━═]{3,}/;
const PROMPT_MARKER = /^\s*›/;
const ESC = "\u001b";

type Region = { lines: string[]; text: string; flat: string };

function nonEmpty(lines: string[]): string[] {
  return lines.filter((line) => line.trim() !== "");
}

function regionLines(all: string[], region: DialogRegion | undefined): string[] {
  const lines = nonEmpty(all);
  if (region === undefined) return lines.slice(-DEFAULT_REGION_LINES);
  if (region === "after-last-rule") {
    const at = all.map((l) => HORIZONTAL_RULE.test(l)).lastIndexOf(true);
    return at < 0 ? lines.slice(-DEFAULT_REGION_LINES) : nonEmpty(all.slice(at + 1));
  }
  if (region === "after-last-prompt-marker") {
    const at = all.map((l) => PROMPT_MARKER.test(l)).lastIndexOf(true);
    return at < 0 ? [] : nonEmpty(all.slice(at));
  }
  if ("firstLines" in region) return lines.slice(0, region.firstLines);
  return lines.slice(-region.lastLines);
}

function toRegion(lines: string[]): Region {
  const text = lines.join("\n");
  return { lines, text, flat: text.toLowerCase().replace(/\s+/g, " ") };
}

function collapse(needle: string): string {
  return needle.toLowerCase().replace(/\s+/g, " ").trim();
}

function matches(match: DialogMatch, region: Region): boolean {
  if (match.contains && !match.contains.every((needle) => region.flat.includes(collapse(needle)))) return false;
  if (match.lineRegex && !match.lineRegex.every((re) => region.lines.some((line) => re.test(line)))) return false;
  if (match.regex && !match.regex.every((re) => re.test(region.text))) return false;
  if (match.any && !match.any.some((m) => matches(m, region))) return false;
  if (match.all && !match.all.every((m) => matches(m, region))) return false;
  if (match.not && match.not.some((m) => matches(m, region))) return false;
  return true;
}

const NUMBERED = /^\s*([❯›>→])?\s*(\d+)[.)]\s+(\S.*?)\s*$/;
const MARKED = /^\s*([❯›])\s+(\S.*?)\s*$/;

function readNumbered(lines: string[]): DialogOption[] {
  const options: DialogOption[] = [];
  for (const line of lines) {
    const m = NUMBERED.exec(line);
    if (!m) continue;
    options.push({ label: m[3], key: m[2], ...(m[1] ? { selected: true } : {}) });
  }
  return options;
}

function readMarked(lines: string[]): DialogOption[] {
  const at = lines.findIndex((l) => MARKED.test(l));
  if (at < 0) return [];
  const indented = (line: string): boolean => /^\s{2,}\S/.test(line);
  let from = at;
  while (from > 0 && indented(lines[from - 1])) from -= 1;
  let to = at;
  while (to + 1 < lines.length && indented(lines[to + 1])) to += 1;
  const options: DialogOption[] = [];
  for (const line of lines.slice(from, to + 1)) {
    const m = MARKED.exec(line);
    if (m) options.push({ label: m[2], selected: true });
    else options.push({ label: line.trim() });
  }
  return options;
}

function readOptions(rule: DialogRule, lines: string[]): DialogOption[] | undefined {
  if (!rule.options) return undefined;
  const options = rule.options === "numbered" ? readNumbered(lines) : readMarked(lines);
  return options.length > 0 ? options : undefined;
}

function tryRules(rules: DialogRule[], all: string[]): DialogClassification | null {
  const ordered = [...rules].sort((a, b) => b.priority - a.priority);
  for (const rule of ordered) {
    const lines = regionLines(all, rule.region);
    if (lines.length === 0) continue;
    if (!matches(rule, toRegion(lines))) continue;
    const options = readOptions(rule, lines);
    const text = lines.join("\n").trim();
    return {
      ruleId: rule.id,
      kind: rule.kind,
      text: text.length > MAX_TEXT_CHARS ? text.slice(-MAX_TEXT_CHARS) : text,
      ...(options ? { options } : {}),
    };
  }
  return null;
}

/**
 * Classify what `harness` is showing. `screenText` is the screen as text; a raw
 * terminal stream (anything carrying an escape) is replayed onto a screen first.
 * A `harness` that is not one of `HARNESSES` gets only the generic rules.
 */
export function classifyDialog(harness: string, screenText: string): DialogClassification | null {
  const text = screenText.includes(ESC) ? renderScreenText(screenText) : screenText.replace(/\r\n?/g, "\n");
  const all = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  const own = isHarness(harness) ? HARNESS_DIALOG_RULES[harness] : null;
  return (own ? tryRules(own.rules, all) : null) ?? tryRules(GENERIC_DIALOG_RULES.rules, all);
}
