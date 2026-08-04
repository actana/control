export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

// Claude Code's AskUserQuestion accepts at most 4 questions of 4 options each;
// anything beyond that in a hook payload is malformed and gets dropped.
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_TEXT_LENGTH = 2000;

export type HarnessQuestionOption = {
  label: string;
  description?: string;
};

export type HarnessQuestion = {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: HarnessQuestionOption[];
};

export type PendingQuestion = {
  id: string;
  taskId: string;
  projectId: string;
  questions: HarnessQuestion[];
  createdAt: number;
};

function capText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_TEXT_LENGTH);
}

function parseOption(raw: unknown): HarnessQuestionOption | null {
  if (!raw || typeof raw !== "object") return null;
  const option = raw as Record<string, unknown>;
  const label = capText(option.label);
  if (!label) return null;
  const description = capText(option.description);
  return description ? { label, description } : { label };
}

function parseQuestion(raw: unknown): HarnessQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  const question = capText(q.question);
  if (!question) return null;
  const options = Array.isArray(q.options)
    ? q.options.map(parseOption).filter((o): o is HarnessQuestionOption => o !== null)
    : [];
  if (options.length === 0) return null;
  const header = capText(q.header);
  return {
    question,
    ...(header ? { header } : {}),
    multiSelect: q.multiSelect === true,
    options: options.slice(0, MAX_OPTIONS),
  };
}

/**
 * Defensive parse of a PreToolUse hook's `tool_input` for AskUserQuestion.
 * The payload is agent-produced but rides an authenticated-yet-open local HTTP
 * endpoint, so treat it as untrusted: trim, cap sizes, drop malformed entries.
 * Returns null when nothing usable remains.
 */
export function parseAskUserQuestionInput(toolInput: unknown): HarnessQuestion[] | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const input = toolInput as Record<string, unknown>;
  if (!Array.isArray(input.questions)) return null;
  const questions = input.questions
    .map(parseQuestion)
    .filter((q): q is HarnessQuestion => q !== null)
    .slice(0, MAX_QUESTIONS);
  return questions.length > 0 ? questions : null;
}
