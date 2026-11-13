// The shape of a dialog rule: data, not code (issue 963).
//
// A rule says "on this harness's screen, in this region, this text means a
// human has to answer". The matching engine is `../harness-dialog-classifier`;
// a rule file only declares rules. Adding a harness or a dialog is adding data.

/** The same values `answer_task` (#959) returns for a prompt. */
export type DialogKind = "question" | "choice" | "confirm" | "permission" | "trust" | "unknown";

/** One selectable answer read off a dialog. */
export type DialogOption = {
  /** The label, without its number or selection glyph. */
  label: string;
  /** The key that picks it where the screen names one (the digit of `1. Yes`). */
  key?: string;
  /** The row the cursor is on, where the screen marks it. */
  selected?: boolean;
};

/**
 * What part of the screen a rule reads. Only ever the region, never the
 * scrollback: text the agent merely printed higher up must not match.
 *  - `{ lastLines: n }`: the last `n` non-empty lines (the default is 12).
 *  - `{ firstLines: n }`: the first `n` non-empty lines (a dialog that owns the
 *    top of the screen, such as a startup trust prompt).
 *  - `"after-last-rule"`: the lines below the last horizontal rule of box-drawing
 *    characters; the last 12 lines when the screen has no rule.
 *  - `"after-last-prompt-marker"`: from the last line that starts with `›`.
 */
export type DialogRegion =
  | { lastLines: number }
  | { firstLines: number }
  | "after-last-rule"
  | "after-last-prompt-marker";

export const DEFAULT_REGION_LINES = 12;

/**
 * A match. Every key present must hold (they are ANDed):
 *  - `contains`: every string is in the region, case-insensitive, whitespace
 *    collapsed (so a wrapped phrase still matches);
 *  - `lineRegex`: every pattern matches at least one whole line;
 *  - `regex`: every pattern matches the region text (lines joined with `\n`);
 *  - `any`: at least one of the sub-matches holds;
 *  - `all`: every sub-match holds;
 *  - `not`: none of the sub-matches holds.
 */
export type DialogMatch = {
  contains?: string[];
  lineRegex?: RegExp[];
  regex?: RegExp[];
  any?: DialogMatch[];
  all?: DialogMatch[];
  not?: DialogMatch[];
};

/** How to read `options` off a matched region. */
export type DialogOptionsReader = "numbered" | "marked";

export type DialogRule = DialogMatch & {
  /** Stable id; rides in `source: "screen:<id>"` on the status event. */
  id: string;
  kind: DialogKind;
  /** Higher is tried first within one rule file. */
  priority: number;
  /** Defaults to `{ lastLines: 12 }`. */
  region?: DialogRegion;
  options?: DialogOptionsReader;
};

export type DialogRuleFile = {
  /** The harness these rules apply to; `generic` applies after a harness's own. */
  harness: string;
  /** Where the rules came from and under what licence, when they were adapted. */
  attribution?: string;
  rules: DialogRule[];
};
