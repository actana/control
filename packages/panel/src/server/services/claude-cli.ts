// Print-mode harness invocation lives in `@actana/core/harness-cli-run` as the
// single source of truth — it already resolved PATH through the Core's own
// resolver, and the title generator that leans on it now runs on the Core
// (issue 84). Re-exported here to preserve existing import paths.
export {
  type RunCliOptions,
  buildCliSpawnInvocation,
  runCli,
} from "../../../../core/src/harness-cli-run";
