// Dialog rules for any harness: the shapes a dialog has whatever draws it.
// Tried after the harness's own rules. Ours, not adapted from another project.

import type { DialogRuleFile } from "./types";

const FOOTER = {
  any: [
    { contains: ["esc to cancel"] },
    { contains: ["esc to exit"] },
    { contains: ["esc to go back"] },
    { contains: ["enter to confirm"] },
    { contains: ["enter to select"] },
    { contains: ["press enter"] },
    { contains: ["enter to continue"] },
  ],
};

export const genericDialogRules: DialogRuleFile = {
  harness: "generic",
  rules: [
    {
      id: "numbered_choice_footer",
      kind: "choice",
      priority: 500,
      region: { lastLines: 14 },
      options: "numbered",
      lineRegex: [/^\s*[❯›>→]?\s*1[.)]\s+\S/, /^\s*[❯›>→]?\s*2[.)]\s+\S/],
      all: [FOOTER],
    },
    {
      id: "arrow_choice_footer",
      kind: "choice",
      priority: 490,
      region: { lastLines: 14 },
      options: "marked",
      // One row marked with the selection glyph and a sibling row right under
      // or over it, plus a confirm or cancel footer.
      regex: [/^[ \t]*[❯›][ \t]+\S[^\n]*\n[ \t]+\S|^[ \t]+\S[^\n]*\n[ \t]*[❯›][ \t]+\S/m],
      all: [FOOTER],
    },
    {
      id: "yes_no_prompt",
      kind: "confirm",
      priority: 400,
      region: { lastLines: 4 },
      regex: [/\[(?:y\/n|Y\/n|y\/N)\]|\((?:y\/n|Y\/n|y\/N)\)/],
    },
    {
      id: "press_enter_to_continue",
      kind: "confirm",
      priority: 300,
      region: { lastLines: 6 },
      contains: ["press enter to continue"],
    },
    {
      id: "press_any_key",
      kind: "unknown",
      priority: 200,
      region: { lastLines: 4 },
      contains: ["press any key to continue"],
    },
  ],
};
