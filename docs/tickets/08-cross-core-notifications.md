# Tickets — Spec 08 (Cross-core notifications)

Parent spec: [`../specs/08-cross-core-notifications.md`](../specs/08-cross-core-notifications.md).

The only **ADD** spec in the batch — extends the existing session-finish
notification pipeline from "loopback-only" to "every registered Core,
uniformly," reusing the core-link event stream. Three tickets, ordered
so each PR leaves `typecheck` and `test` green. The store/type surface
lands first (backward-compatible read path), then the hook grows its
second subscription, then the OS-notification + click-through payload
picks up `coreId` end-to-end.

Nearly disjoint from every other spec's file surface — safe to run in
parallel with spec 04 (recall/memory) and spec 07 (convenience) in the
first wave. No shared files with spec 01 / 02 either.

---

## AC-08-01 — Extend `SessionFinishNotification` + store with `coreId` / `coreAlias`

**Depends on:** —

**Summary.** Land the atomic type surface first. Adds
`coreId: string` (required) and `coreAlias: string | null` (optional
cached label) to `SessionFinishNotification`, threads `coreId` through
`PendingNotificationOpen`, extends the parser to default `coreId` to
`LOOPBACK_CORE_ID` on records written by older Panels, and widens the
dedup filter in `mergeSessionFinishNotification` from
`(kind, id, projectId)` to `(kind, coreId, id, projectId)` so the same
`sessionId` on two different Cores does not collapse. Prune predicates
in `notificationMatchesPruneTarget` gain a `coreId` scope. Existing
callers keep compiling because loopback continues to pass
`LOOPBACK_CORE_ID`; the hook still synthesizes the value at consumption
time until AC-08-02.

**Files touched (indicative).**
- Modify: `src/lib/session-notification-store.ts` — add `coreId` +
  `coreAlias` to `SessionFinishNotification`, add `coreId` to
  `PendingNotificationOpen`, extend `toSessionFinishNotification` with
  the `LOOPBACK_CORE_ID` backfill, widen the dedup tuple in
  `mergeSessionFinishNotification`, extend
  `SessionNotificationPruneTarget` (task / project / worktree variants)
  with `coreId` and adjust `notificationMatchesPruneTarget`.
- Modify: `src/lib/use-session-finish-notifications.tsx` — thread
  `coreId = LOOPBACK_CORE_ID` and `coreAlias = null` through the
  existing SSE-branch call sites so the widened store types still
  compile. No behavior change (fleet subscription lands in AC-08-02).
- Add: (none — extend existing modules only.)

**Acceptance criteria.**
- `rg "SessionFinishNotification|PendingNotificationOpen|mergeSessionFinishNotification|notificationMatchesPruneTarget"`
  in `src/lib/` shows every surface now carrying a `coreId` field.
- `rg "LOOPBACK_CORE_ID"` in `src/lib/session-notification-store.ts`
  and `src/lib/use-session-finish-notifications.tsx` returns at least
  one hit each (backfill + loopback synthesis).
- Existing store unit tests still pass; new cases cover: two Cores with
  the same `sessionId` produce two rows, a stored record without
  `coreId` deserializes with `coreId = LOOPBACK_CORE_ID` /
  `coreAlias = null`, and prune targets scoped by `coreId` do not
  cross-delete.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** No SQL migration — notifications are `localStorage`-only
under `mc:sessionFinishNotifications`. The `coreId` / `coreAlias`
fields are added to the in-memory shape and the JSON-serialized blob
only; first write after upgrade rewrites each record with the new
fields.

---

## AC-08-02 — Subscribe `useSessionFinishNotifications` to `electron.fleet.onEvent`

**Depends on:** AC-08-01

**Summary.** The core behavior change. Adds a second `useEffect` in
`useSessionFinishNotifications` that subscribes to
`electron.fleet.onEvent` when the bridge exists, extracts the "handle a
normalized finished event" body into a local
`normalizeSessionFinishedEvent(source, raw)` helper so both the SSE
branch and the fleet branch feed the same downstream pipeline, and
installs a module-scope bounded LRU `Set<string>` (cap 500,
drop-oldest) keyed on `${coreId}::${sessionId}::${eventId ?? "sse"}` to
suppress duplicate fast-path fires. Core alias is resolved via
`useCores()` from `~/queries` (already imported elsewhere). Toast body
becomes `Session finished — {projectName} on {coreAlias}` for
non-loopback origins (unchanged for loopback); if `coreAlias` is
null/empty, falls back to the raw `coreId`. Also extends the existing
`pruneNotifications` handler so remote-Core `project:deleted` /
`task:deleted` / `worktree:deleted` frames on the same fleet stream
route through with the correct `coreId` scope.

**Files touched (indicative).**
- Modify: `src/lib/use-session-finish-notifications.tsx` — new fleet
  subscription effect, `normalizeSessionFinishedEvent` private helper
  returning `NormalizedFinish | null` (shape per spec), module-scope
  dedup `Set<string>` with `dedupKey`, `useCores()` alias lookup,
  updated toast body composition, extended prune routing for the three
  deletion event kinds.
- Add: (none — helper is private inside the existing hook file; no new
  hook, no new module.)

**Acceptance criteria.**
- `rg "electron\.fleet\.onEvent"` in `src/lib/use-session-finish-notifications.tsx`
  returns at least one hit.
- `rg "normalizeSessionFinishedEvent|dedupKey"` in the same file
  returns hits for both the helper and the dedup predicate.
- Unit: `dedupKey` yields distinct keys for `(coreA, s1, 5)` vs
  `(coreA, s1, 6)` vs `(coreB, s1, 5)`, and an SSE loopback event with
  `null` eventId dedups against itself.
- Integration: a fake `electron.fleet.onEvent` emitting a synthesized
  remote `session:finished` frame fires exactly one toast whose title
  contains ` on {coreAlias}`, merges exactly one stored notification
  with `coreId = "core_a"`, and — when the setting is on — fires
  exactly one OS notification.
- Integration: replay tail — the same `(coreId, eventId)` re-emitted
  after a simulated reconnect drops silently; exactly one toast total.
- Integration: loopback finish still fires a toast whose title has no
  ` on ` suffix (regression on existing shape).
- Integration: `sessionFinishToastEnabled = false` suppresses toasts
  uniformly across loopback and remote; sound toggle honored uniformly.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `src/server/events.ts`, `src/server/services/tasks.ts`, and
`electron/remote-core-dialer.ts` are intentionally **not** touched —
loopback continues to emit its existing shape, and the dialer already
surfaces `{ coreId, event }` for every Core. `PtyCoreLinkClient` already
persists `lastEventId` per Core via `updateCoreLastEventId`, so replay
on reconnect flows through the same `onEvent` fanout and the dedup Set
collapses it.

---

## AC-08-03 — Thread `coreId` / `coreAlias` through OS notification + click routing

**Depends on:** AC-08-02

**Summary.** Finish the wire end-to-end. Extends
`SessionFinishOsNotificationPayload` with `coreId: string` and
`coreAlias: string | null`, has the renderer pre-compose the
Core-aliased `title` / `body` (`Session finished — {projectName} on
{coreAlias}` for remote, unchanged for loopback) so main-process code
just displays what it is given, and threads `coreId` through
`subscribeSessionFinishOsNotificationClick` so clicking a remote
notification routes into the Fleet-view scope for the origin Core
before opening the session. Loopback click behavior is unchanged
(navigate to `/projects/$id` and enqueue `PendingNotificationOpen`);
remote click navigates to the Fleet view scoped by `coreId` (the route
already accepts a `coreId` search param — see `FleetView.tsx`) and then
opens the project scoped to that Core. `SessionNotificationsButton`
gains a small inline badge showing the Core alias next to the project
name for non-loopback entries.

**Files touched (indicative).**
- Modify: `src/lib/os-notifications.ts` — extend
  `SessionFinishOsNotificationPayload` with `coreId` + `coreAlias`,
  extend `subscribeSessionFinishOsNotificationClick` payload with
  `coreId`.
- Modify: `electron/session-finish-notification.ts` — accept + forward
  `coreId` on the main-process `Notification` and its `click` handler
  payload.
- Modify: `src/lib/use-session-finish-notifications.tsx` — compose the
  Core-aliased `title` / `body` in the renderer, pass `coreId` into
  `showSessionFinishOsNotification`, consume `coreId` in the click
  handler to drive Fleet-view navigation for remote origins.
- Modify: `src/components/views/SessionNotificationsButton.tsx` (or
  wherever the notifications list currently renders) — show the Core
  alias as an inline badge next to the project name for entries where
  `coreId !== LOOPBACK_CORE_ID`; empty state unchanged.
- Add: (none.)

**Acceptance criteria.**
- `rg "coreId" electron/session-finish-notification.ts src/lib/os-notifications.ts`
  shows the field on both the payload and the click subscription.
- Integration: click-through — clicking a remote notification enqueues
  a `PendingNotificationOpen` carrying the correct `coreId` and drives
  navigation into Fleet view scoped to that Core; clicking a loopback
  notification behaves exactly as before.
- Integration: OS notification (when
  `sessionFinishOsNotificationEnabled = true`) includes the Core alias
  in the title for remote origins and omits it for loopback.
- Integration: deleting a project/task/worktree on a remote Core prunes
  the corresponding remote-origin notifications from the store (scoped
  by `coreId`) without touching loopback rows.
- Notifications list renders the Core-alias badge for remote entries
  only; loopback entries visually unchanged.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** No changes to `electron/notification-permissions.ts` — the
permission model is unchanged and the audio-capture gate is orthogonal
(and removed by spec 01). The native `Notification` path is Panel-side
and OS-agnostic to the origin Core; the remote Harness never touches
OS-notification APIs. Per-Core muting, cross-kind cross-core
notifications (`Core unreachable`, `Harness update available`, etc.),
SQLite-backed persistence, and burst-grouping are all explicitly out of
scope per the parent spec's follow-ups.
