// Question parsing lives in `@actana/shared/harness-questions` as the single
// source of truth — the hook payloads it reads now land on the Core's own hook
// receiver (issue 84). Re-exported here to preserve existing import paths.
export {
  type HarnessQuestion,
  type PendingQuestion,
  parseAskUserQuestionInput,
} from "@actana/shared/harness-questions";
