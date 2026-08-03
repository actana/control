// Minimal harness registry: display labels for the New Session menu.
// Post-ADR-0006, harness-side install segments and capabilities are gone —
// the Panel does not touch the operator's harness config surface.
export const HARNESS_REGISTRY = {
  claude: { id: "claude", label: "Claude Code" },
  codex: { id: "codex", label: "Codex" },
  cursor: { id: "cursor", label: "Cursor CLI" },
} as const;

export type HarnessId = keyof typeof HARNESS_REGISTRY;
