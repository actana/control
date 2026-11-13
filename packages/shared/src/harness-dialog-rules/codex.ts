// Dialog rules for Codex.
//
// Source: herdr detection manifest `src/detect/manifests/codex.toml`
// (manifest 2026.10.11.1), herdr commit ee5bfb5, Apache-2.0,
// https://github.com/herdrdev/herdr. Translated into this repo's rule format;
// herdr's matching engine is not ported.
//
// Not translated: herdr's `osc_title_blocked` reads the terminal window title
// ("Action Required"), which is not part of the screen text. A title is not
// something `classifyDialog(harness, screenText)` is given.

import type { DialogRuleFile } from "./types";

export const codexDialogRules: DialogRuleFile = {
  harness: "codex",
  attribution: "herdr codex.toml 2026.10.11.1, commit ee5bfb5, Apache-2.0 (https://github.com/herdrdev/herdr)",
  rules: [
    {
      id: "trust_directory",
      kind: "trust",
      priority: 950,
      region: { firstLines: 20 },
      options: "numbered",
      all: [
        {
          any: [{ regex: [/^> You are in [^\r\n]+(?:\r?\n|$)/] }, { contains: ["Folder access"] }],
        },
        {
          any: [
            { regex: [/Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+directory\?/is] },
            {
              all: [
                { contains: ["Trust this folder?", "Codex can read, edit, and run files here"] },
                { any: [{ contains: ["Trust and continue"] }, { contains: ["enter continue"] }] },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "startup_update",
      kind: "choice",
      priority: 950,
      region: { lastLines: 20 },
      options: "numbered",
      // The legacy dialog; the shared picker (0.159+) has another heading and
      // footer. The passive update history notice has neither picker footer.
      any: [
        {
          all: [
            { contains: ["Update available!", "Update now"] },
            { regex: [/Skip\s+until\s+next\s+version/, /Press enter to continue\s*$(?![\s\S])/] },
          ],
        },
        {
          all: [
            { regex: [/^\s*Update\s+available\s+·/m] },
            { regex: [/enter\s+continue\s+·\s+esc\s+skip\s*$(?![\s\S])/] },
          ],
        },
      ],
    },
    {
      id: "live_strong_blocker",
      kind: "choice",
      priority: 900,
      region: "after-last-prompt-marker",
      options: "numbered",
      any: [
        { contains: ["press enter to confirm or esc to cancel"] },
        { contains: ["enter to submit answer"] },
        { contains: ["enter to submit all"] },
        { contains: ["allow command?"] },
        { contains: ["All Results", "Filesystem Only", "Plugins"] },
      ],
    },
    {
      id: "weak_blocker",
      kind: "confirm",
      priority: 600,
      region: { lastLines: 20 },
      options: "numbered",
      // A sparkle can replace the space after ›; a later response marker makes
      // that prompt stale.
      not: [
        { regex: [/^›[⠁⠂⠄⠈⠐⠠⡀⢀][^\n]*(?:\n(?:[^•■✗✓\n][^\n]*)?)*(?![\s\S])/m] },
        // The idle composer: a `›` line that is not a numbered option (`› 1. Yes` stays matchable), then its status
        // line (`model · cwd`, or `? for shortcuts` before the model is known). A reply above that asks a question
        // is not a dialog.
        { regex: [/^\s*›\s+(?!\d+[.)])\S[^\n]*\n(?:[ \t]*\n)*[ \t]+(?!\d+[.)])(?:\?\s+for shortcuts|\S.*·)/m] },
      ],
      any: [
        { contains: ["[y/n]"] },
        { contains: ["yes (y)"] },
        { contains: ["do you want to"], any: [{ contains: ["yes"] }, { contains: ["❯"] }] },
        { contains: ["would you like to"], any: [{ contains: ["yes"] }, { contains: ["❯"] }] },
      ],
    },
  ],
};
