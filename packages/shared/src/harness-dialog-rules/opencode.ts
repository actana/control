// Dialog rules for OpenCode.
//
// Source: `permission_required` and `dialog_footer` are adapted from herdr's
// detection manifest `src/detect/manifests/opencode.toml` (manifest
// 2026.06.10.1), herdr commit ee5bfb5, Apache-2.0,
// https://github.com/herdrdev/herdr. Translated into this repo's rule format;
// herdr's matching engine is not ported. herdr has one rule with two branches;
// here each branch is a rule of its own so the kind is exact. OpenCode's own
// `permission.asked` hook reports permission dialogs when its plugin is loaded;
// these rules are the fallback for when it is not, and for dialogs it does not report.

import type { DialogRuleFile } from "./types";

export const opencodeDialogRules: DialogRuleFile = {
  harness: "opencode",
  attribution: "herdr opencode.toml 2026.06.10.1, commit ee5bfb5, Apache-2.0 (https://github.com/herdrdev/herdr)",
  rules: [
    {
      id: "permission_required",
      kind: "permission",
      priority: 300,
      region: { lastLines: 20 },
      contains: ["△ Permission required"],
    },
    {
      id: "dialog_footer",
      kind: "choice",
      priority: 290,
      region: { lastLines: 20 },
      options: "numbered",
      // The footer every OpenCode dialog (a question, a select) draws.
      contains: ["esc dismiss"],
      any: [{ contains: ["enter confirm"] }, { contains: ["enter submit"] }, { contains: ["enter toggle"] }],
      all: [{ any: [{ contains: ["↑↓ select"] }, { contains: ["⇆ tab"] }] }],
    },
  ],
};
