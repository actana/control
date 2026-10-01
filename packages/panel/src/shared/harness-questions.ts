// Question parsing lives in `@actana/shared/harness-questions` as the single
// source of truth — the hook payloads it reads now land on the Core's own hook
// receiver (issue 84). Re-exported here to preserve existing import paths.
import type { HarnessQuestion } from "@actana/shared/harness-questions";

export {
  ASK_USER_QUESTION_TOOL,
  type HarnessQuestion,
  type HarnessQuestionOption,
  parseAskUserQuestionInput,
} from "@actana/shared/harness-questions";

// The Panel's own pending-question row. It lived in `@actana/shared` with the
// project id it carries, but a Core has no Projects (ADR 0041 D1), so the type
// is the Panel's now, until #560 removes the id from it.
export type PendingQuestion = {
  id: string;
  sessionId: string;
  projectId: string;
  questions: HarnessQuestion[];
  createdAt: number;
};
