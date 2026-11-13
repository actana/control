// The registry: one rule file per harness of `HARNESSES`, plus `generic`.
//
// The record is keyed by `Harness`, so a harness added to `HARNESSES` fails the
// typecheck here until it has a file. Adding rules to a harness is editing its
// own file; nothing in the classifier names a harness.

import type { Harness } from "../domain";
import { claudeCodeDialogRules } from "./claude-code";
import { codexDialogRules } from "./codex";
import { cursorCliDialogRules } from "./cursor-cli";
import { genericDialogRules } from "./generic";
import { opencodeDialogRules } from "./opencode";
import { piDialogRules } from "./pi";
import type { DialogRuleFile } from "./types";

export * from "./types";

export const HARNESS_DIALOG_RULES: Record<Harness, DialogRuleFile> = {
  "claude-code": claudeCodeDialogRules,
  codex: codexDialogRules,
  "cursor-cli": cursorCliDialogRules,
  opencode: opencodeDialogRules,
  pi: piDialogRules,
};

export const GENERIC_DIALOG_RULES: DialogRuleFile = genericDialogRules;
