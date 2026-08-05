// The hook-event vocabulary and its status mapping live in
// `@actana/shared/harness-hook-events` as the single source of truth — hooks
// for a Core-owned Session report to the Core's own receiver (issue 84), so
// both processes map the same event names to the same statuses. Re-exported
// here to preserve existing import paths.
export {
  HARNESS_HOOK_EVENTS,
  type HarnessHookPayload,
  mapHookEventToStatus,
} from "@actana/shared/harness-hook-events";
