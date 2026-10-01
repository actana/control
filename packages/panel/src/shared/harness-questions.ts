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

// The Panel's own pending-question row. A Core has no Projects (ADR 0041 D1), so
// the row names a Session and nothing wider.
export type PendingQuestion = {
  id: string;
  sessionId: string;
  questions: HarnessQuestion[];
  createdAt: number;
};
