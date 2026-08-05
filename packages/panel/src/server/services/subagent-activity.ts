// The subagent-activity state machine lives in `@actana/shared/subagent-activity`
// as the single source of truth — hooks for a Core-owned Session report to the
// Core's own receiver (issue 84), so the Core needs the same `Stop`-downgrade
// bookkeeping this process has always had, with the same tuned windows. Each
// process holds its own state; only the code is shared. Re-exported here to
// preserve existing import paths.
export {
  noteTaskFinished,
  taskFinishedRecently,
  clearTaskFinished,
  noteSubagentStart,
  noteSubagentStop,
  hasActiveSubagents,
  armDeferredFinish,
  disarmDeferredFinish,
  clearSubagentActivity,
} from "@actana/shared/subagent-activity";
