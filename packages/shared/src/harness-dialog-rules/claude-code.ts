// Dialog rules for Claude Code.
//
// Source: herdr detection manifest `src/detect/manifests/claude.toml`
// (manifest 2026.10.11.1), herdr commit ee5bfb5, Apache-2.0,
// https://github.com/herdrdev/herdr. Translated into this repo's rule format;
// herdr's matching engine is not ported. `visible_blocker` has no counterpart:
// a rule here only ever reads the visible region. `folder_trust` is ours, from
// the real Claude Code 2.1.228 trust screen.
//
// Regexes use RegExp objects: `\z` is written `(?![\s\S])`, `(?m)` is the `m` flag.

import type { DialogRuleFile } from "./types";

const WHOLE_RECENT = { lastLines: 20 } as const;

export const claudeCodeDialogRules: DialogRuleFile = {
  harness: "claude-code",
  attribution: "herdr claude.toml 2026.10.11.1, commit ee5bfb5, Apache-2.0 (https://github.com/herdrdev/herdr)",
  rules: [
    {
      id: "folder_trust",
      kind: "trust",
      priority: 990,
      region: "after-last-rule",
      options: "numbered",
      contains: ["i trust this folder", "esc to cancel"],
    },
    {
      id: "live_blocked_form",
      kind: "choice",
      priority: 980,
      region: "after-last-rule",
      options: "numbered",
      contains: ["esc to cancel"],
      any: [
        { contains: ["enter to confirm"] },
        {
          contains: ["enter to select"],
          any: [
            { contains: ["tab/arrow keys to navigate"] },
            { contains: ["arrow keys to navigate"] },
            { contains: ["arrows to navigate"] },
            { contains: ["↑/↓ to navigate"] },
            { contains: ["↑↓ to navigate"] },
          ],
        },
      ],
    },
    {
      id: "live_blocked_form_named_session",
      kind: "choice",
      priority: 980,
      region: WHOLE_RECENT,
      options: "numbered",
      // Every control bound to the same footer, wrapping allowed between words.
      // After the name divider only a counted task panel with marked rows (and
      // optional pending overflow) may follow: free-form activity can be newer
      // output (herdr #4573).
      regex: [
        /(?:^|\n)[ \t]*enter\s+to\s+(?:confirm|select\s+·\s+(?:(?:tab\/arrow|arrow)\s+keys|arrows|↑\/↓|↑↓)\s+to\s+navigate)\s+·\s+esc\s+to\s+cancel[ \t]*\n(?:[ \t]*\n)*[ \t]*─{3,}[^\n]*(?:\n(?:[ \t]*\n)*[ \t]+\d+ tasks? \(\d+ done, (?:\d+ in progress, )?\d+ open\)(?:\n[ \t]+[◻◼✔][ \t]+[^\n]+)+(?:\n[ \t]+…[ \t]+\+\d+[ \t]+pending)?)?(?:\n[ \t]*)*(?![\s\S])/i,
      ],
    },
    {
      id: "dynamic_workflow_prompt",
      kind: "confirm",
      priority: 980,
      region: WHOLE_RECENT,
      contains: ["run a dynamic workflow?", "esc to cancel"],
    },
    {
      id: "mcp_elicitation_prompt",
      kind: "question",
      priority: 980,
      region: WHOLE_RECENT,
      // MCP elicitation dialogs show Accept/Decline with an "Esc to cancel"
      // footer and no Enter hint (herdr #3283): gate on the header line, the
      // Accept/Decline line and the footer.
      contains: ["esc to cancel"],
      lineRegex: [/^\s*MCP server ["“].+["”] requests your input\s*$/i],
      all: [
        { any: [{ lineRegex: [/^\s*❯?\s*Accept\b/] }, { lineRegex: [/^\s*❯?\s*Decline\b/] }] },
      ],
    },
    {
      id: "bash_permission_prompt",
      kind: "permission",
      priority: 850,
      region: WHOLE_RECENT,
      options: "numbered",
      contains: ["do you want to proceed?"],
      any: [
        { contains: ["bash command"] },
        { contains: ["bash("] },
        { contains: ["contains expansion"] },
        { contains: ["tab to amend"] },
        { contains: ["ctrl+e to explain"] },
      ],
      // Claude marks the selected option with ❯, so every branch allows it
      // (herdr #2650).
      all: [
        {
          any: [
            { lineRegex: [/^\s*❯?\s*yes\b/i] },
            { lineRegex: [/^\s*❯?\s*1\.\s*yes\b/i] },
            { lineRegex: [/^\s*❯?\s*2\.\s*yes\b/i] },
            { lineRegex: [/^\s*❯?\s*2\.\s*no\b/i] },
            { lineRegex: [/^\s*❯?\s*3\.\s*no\b/i] },
          ],
        },
      ],
    },
    {
      id: "generic_permission_prompt",
      kind: "permission",
      priority: 840,
      region: "after-last-rule",
      options: "numbered",
      contains: ["do you want to proceed?", "esc to cancel"],
      all: [
        {
          any: [
            { lineRegex: [/^\s*❯?\s*1\.\s*yes\b/i] },
            { lineRegex: [/^\s*2\.\s*yes\b/i] },
            { lineRegex: [/^\s*2\.\s*no\b/i] },
            { lineRegex: [/^\s*3\.\s*no\b/i] },
          ],
        },
      ],
    },
    {
      id: "legacy_no_prompt_blocker",
      kind: "unknown",
      priority: 300,
      region: WHOLE_RECENT,
      options: "numbered",
      any: [
        { contains: ["do you want to"], any: [{ contains: ["yes"] }, { contains: ["❯"] }] },
        { contains: ["would you like to"], any: [{ contains: ["yes"] }, { contains: ["❯"] }] },
        { contains: ["waiting for permission"] },
        { contains: ["do you want to allow this connection?"] },
        { contains: ["tab to amend"] },
        { contains: ["ctrl+e to explain"] },
        { contains: ["do you want to proceed?", "esc to cancel"] },
        { contains: ["review your answers"] },
        { contains: ["skip interview and plan immediately"] },
      ],
      not: [{ regex: [/^\s*❯\s*$/m] }],
    },
  ],
};
