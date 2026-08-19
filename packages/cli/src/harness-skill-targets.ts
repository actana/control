// Where a global agent skill goes, for each Harness this build knows.
//
// **A hand-declared copy of `HARNESS_SKILL_TARGETS` in `@actana/shared`**, which
// this package may not import (ADR 0025 D4, swept by `no-local-escape.test.ts`).
// The copy is not maintained by memory: `orchestration-skill-fanout.test.ts` in
// `packages/shared` reads both and fails when they disagree, and fails again
// when either is missing a member of `HARNESSES`. That is the arrangement
// ADR 0025 D3 permits and `registration-blob-file.ts` already lives under —
// the same reason this package duplicates a blob decoder rather than import one.
//
// Every row's `source` and `verifiedOn` are the vendor page the directory was
// read off and the date it was read. Nothing in this repository recorded a
// global skill directory for any Harness before #265, so a reader who doubts a
// path has the citation rather than a search engine. ADR 0031 D4 explains why
// four harnesses resolve to two directories.

import type { SkillInstallTarget } from "./orchestration-skill-install.ts";

export type HarnessSkillTargetRow = SkillInstallTarget & {
  source: string;
  verifiedOn: string;
};

export const HARNESS_SKILL_TARGETS: readonly HarnessSkillTargetRow[] = [
  {
    harness: "claude-code",
    kind: "skill-dir",
    homeMarkers: [".claude"],
    skillDir: ".claude/skills",
    source:
      'https://code.claude.com/docs/en/skills — "Where skills live": Personal, `~/.claude/skills/<skill-name>/SKILL.md`',
    verifiedOn: "2026-08-19",
  },
  {
    harness: "codex",
    kind: "skill-dir",
    homeMarkers: [".codex"],
    skillDir: ".agents/skills",
    source:
      "https://developers.openai.com/codex/skills — skill locations table, USER scope: `$HOME/.agents/skills`",
    verifiedOn: "2026-08-19",
  },
  {
    harness: "cursor-cli",
    kind: "skill-dir",
    homeMarkers: [".cursor"],
    skillDir: ".agents/skills",
    source:
      'https://cursor.com/help/customization/skills — "Skills are automatically loaded from .agents/skills/, .cursor/skills/, ~/.agents/skills/ (global), and ~/.cursor/skills/ (global)"',
    verifiedOn: "2026-08-19",
  },
  {
    harness: "opencode",
    kind: "skill-dir",
    homeMarkers: [".opencode", ".config/opencode"],
    skillDir: ".agents/skills",
    source:
      "https://opencode.ai/docs/skills — global paths: `~/.config/opencode/skills/<name>/SKILL.md`, `~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md`",
    verifiedOn: "2026-08-19",
  },
];
