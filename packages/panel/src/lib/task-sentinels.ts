// The sentinel titles live in `@actana/shared/task-sentinels` as the single
// source of truth — a Core-owned Session's title is generated on its Core
// (issue 84), so both processes have to agree on what "not named yet" looks
// like. Re-exported here to preserve existing import paths.
export { TITLE_WAITING, TITLE_GENERATING, isSentinelTitle } from "@actana/shared/task-sentinels";
