// The standard block the Core appends to every prompt it delivers (ADR 0026,
// issue 563). It is how a harness learns, without the operator saying so, where
// it is, what is shared and where its report goes — the report path is the
// contract of actana/client#8.
//
// One line, on purpose. Delivery types the prompt like a human and
// `sanitizeInitialInput` flattens every line ending to a space, so there is no
// per-harness line ending to vary: the block is the same text for every
// harness, and the tests pin that.

/** Bump on any change to the wording below; a Session records the version it got. */
export const PROMPT_BLOCK_VERSION = 1;

/** The fixed last line a report ends with. A watcher settles on it (client#8). */
export const REPORT_END_MARKER = "ACT-REPORT-END";

/** Where a plain Session turn writes its report, relative to the home directory. */
export function reportPath(sessionId: string, turn: number): string {
  return `shared/sessions/${sessionId}/report-${turn}.md`;
}

const BLOCK_OPEN = `[Actana standard block v${PROMPT_BLOCK_VERSION}]`;

export function buildPromptBlock(input: { sessionId: string; turn: number }): string {
  const path = `~/${reportPath(input.sessionId, input.turn)}`;
  return (
    `${BLOCK_OPEN} ` +
    "Your workspace is your home directory (~); go into a subfolder only when this prompt says so. " +
    "~/shared is shared with the operator and syncs within seconds. " +
    `When this turn is done, write your report to ${path} and make its last line exactly ${REPORT_END_MARKER}. ` +
    "Never use sudo."
  );
}

/**
 * `text` with the block after it, exactly once: a prompt that already carries a
 * block of any version is returned as it is, so a resend never stacks a second.
 */
export function appendPromptBlock(text: string, input: { sessionId: string; turn: number }): string {
  if (/\[Actana standard block v\d+\]/.test(text)) return text;
  return `${text} ${buildPromptBlock(input)}`;
}
