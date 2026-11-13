// Dialog rules for Pi.
//
// Ours: herdr has no `blocked` rule for Pi. Pi's `ui_prompt_start` hook reports
// the dialogs an extension raises (select, confirm, input, editor, custom); these
// rules cover what the hook does not see:
//  - the project-trust prompt, which Pi draws before any extension (and so the
//    Actana extension) is loaded; the rule text is from the real Pi 0.85.1 screen
//    (the fixture `pi-0.85.1-project-trust`);
//  - Pi's own selectors (`/login`, `/model`, session and settings pickers), which
//    share one footer: `↑↓ navigate  enter select  escape/ctrl+c cancel`.
// Pi marks the selected row with `→`; the idle composer's footer reads
// `escape interrupt · ctrl+c/ctrl+d clear/exit`, which neither rule matches.

import type { DialogRuleFile } from "./types";

export const piDialogRules: DialogRuleFile = {
  harness: "pi",
  rules: [
    {
      id: "project_trust",
      kind: "trust",
      priority: 950,
      region: { lastLines: 16 },
      options: "marked",
      contains: ["trust project folder?", "enter select"],
    },
    {
      id: "selector_footer",
      kind: "choice",
      priority: 500,
      region: { lastLines: 14 },
      options: "marked",
      contains: ["navigate", "enter select"],
      any: [{ contains: ["escape/ctrl+c cancel"] }, { contains: ["escape cancel"] }, { contains: ["esc cancel"] }],
      lineRegex: [/^\s*→\s+\S/],
    },
  ],
};
