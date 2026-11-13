// Dialog rules for Cursor CLI (`cursor-agent`).
//
// Source: `write_file_approval` and `approval_prompt` are adapted from herdr's
// detection manifest `src/detect/manifests/cursor.toml` (manifest 2026.08.03.1),
// herdr commit ee5bfb5, Apache-2.0, https://github.com/herdrdev/herdr.
// Translated into this repo's rule format; herdr's matching engine is not
// ported. `workspace_trust` is ours, from the real cursor-agent 2026.08.11
// "Workspace Trust Required" screen (the fixture `cursor-agent-2026.08.11-folder-trust`).

import type { DialogRuleFile } from "./types";

export const cursorCliDialogRules: DialogRuleFile = {
  harness: "cursor-cli",
  attribution:
    "herdr cursor.toml 2026.08.03.1, commit ee5bfb5, Apache-2.0 (https://github.com/herdrdev/herdr); workspace_trust is ours",
  rules: [
    {
      id: "workspace_trust",
      kind: "trust",
      priority: 950,
      region: { lastLines: 14 },
      options: "marked",
      contains: ["workspace trust required", "trust this workspace"],
    },
    {
      id: "write_file_approval",
      kind: "permission",
      priority: 320,
      region: { lastLines: 8 },
      options: "marked",
      contains: ["write to this file?", "proceed (y)"],
      any: [
        { contains: ["reject & propose changes"] },
        { contains: ["esc or n or p"] },
        { contains: ["add write("] },
      ],
    },
    {
      id: "approval_prompt",
      kind: "permission",
      priority: 300,
      region: { lastLines: 20 },
      options: "marked",
      any: [
        {
          contains: ["waiting for approval", "run this command?"],
          any: [{ contains: ["run (once) (y)"] }, { contains: ["skip (esc or n)"] }],
        },
        { contains: ["(y) (enter)"] },
        { lineRegex: [/^\s*allow .*\(y\)/i] },
        { contains: ["keep (n)"] },
        { contains: ["skip (esc or n)"] },
        { lineRegex: [/^\s*(?:→\s*)?run .*\(y\)/i] },
      ],
    },
  ],
};
