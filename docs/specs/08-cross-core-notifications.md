# 08 — Cross-Core session-finish notifications

Ratifies ADR 0008. Extends the existing session-finish notification pipeline from "loopback-only" to "every registered Core, uniformly," reusing the core-link event stream. No new transport, no new settings, no per-Core listener plumbing beyond what `RemoteCoreDialer` already provides.

## Overview

Today, `useSessionFinishNotifications` subscribes to the Panel's SSE stream (`useServerEvents`), which is fed only by the in-process loopback Harness (`src/server/events.ts`). Remote-Core session finishes travel over core-link as `CoreLinkEvent { kind: "session:finished", … }` frames but are consumed only by fleet-refetch hooks — they never reach the notification hook, so a remote Session finishing produces no toast and no OS notification.

Target: `useSessionFinishNotifications` subscribes to the union of (a) the loopback SSE stream and (b) `electron.fleet.onEvent` (the coreId-tagged remote fanout from `RemoteCoreDialer.onEvent`). Every registered Core triggers the same Panel-side toast + optional OS notification, keyed and deduplicated by `(coreId, sessionId, eventId)`, with the Core alias woven into the body for non-loopback origins.

## Current architecture (short)

- Loopback origin: `updateStatus` in `src/server/services/tasks.ts` emits `events.emit("session:finished", { id, projectId, worktreeId, scopeId, projectName, taskTitle })` when a task transitions to `finished`. The Panel's SSE endpoint fans this out; `useServerEvents` delivers a flat `ServerEvent` (fields present as top-level keys).
- Hook: `src/lib/use-session-finish-notifications.tsx` calls `useServerEvents(handler)`. On `e.type === "session:finished"`, it builds a `SessionFinishNotification`, calls `mergeSessionFinishNotification` → `publishAppNotifications`, plays the ding, then renders the toast via `mcToastCustom` and (if enabled) fires an OS notification via `showSessionFinishOsNotification`.
- Toast: rendered by the same hook (`Session finished — {projectName}` + `{taskTitle}`); OS notification fires through `electron.notifications.showSessionFinished` → `electron/session-finish-notification.ts` (main-process `Notification`), with click routed back via `subscribeSessionFinishOsNotificationClick`.
- Persistence: notifications live in `localStorage` under `mc:sessionFinishNotifications` (`SESSION_FINISH_NOTIFICATIONS_STORAGE_KEY`), capped at 200, managed by `src/lib/session-notification-store.ts`. No SQLite row. No `coreId` field today; every stored notification is implicitly loopback.
- Remote events: `RemoteCoreDialer` already surfaces every remote Core's monotonic event log through `client.onEvent → this.eventListeners` and IPC-forwards to `electron.fleet.onEvent(cb)` as `{ coreId, event: CoreLinkEvent }`. The `event.payload` is a JSON string (kind-specific shape). `session:finished` already lands in that stream — nothing new is required Harness-side.

## Target architecture (short)

- `useSessionFinishNotifications` gains a second subscription source: `electron.fleet.onEvent` (remote Cores). The existing `useServerEvents(handler)` continues to serve loopback.
- On any incoming `session:finished` (from either source), the hook normalizes to a common shape (`{ coreId, sessionId, eventId, projectId, worktreeId, scopeId, projectName, taskTitle }`), dedupes by `(coreId, sessionId, eventId)`, and dispatches to the same downstream (store merge, ding, toast, OS notification).
- Loopback origin uses `coreId = LOOPBACK_CORE_ID` and `eventId = undefined` (SSE has no `eventId`; loopback dedup falls back to `(coreId, sessionId)` and to the existing store merge idempotency).
- Remote origin uses `msg.coreId` and `msg.event.eventId`; the payload JSON supplies the session-finished body fields, parsed via `JSON.parse(event.payload)`.
- Core alias resolution: the hook reads `useCores()` (or the existing registry snapshot) to map `coreId → CoreEntry.label`. Alias is written into the stored notification and folded into the OS-notification body.
- Reconnect replay is already handled by `PtyCoreLinkClient` (per-Core `lastEventId` cursor persisted in the Core registry via `updateCoreLastEventId`). Replayed `session:finished` events land on the same `onEvent` fanout; the dedup key prevents double-firing.

## Files to modify

- `src/lib/use-session-finish-notifications.tsx`
  - Add a second `useEffect` that subscribes to `electron.fleet.onEvent` (when `electron.fleet?.onEvent` exists).
  - Extract the "handle a normalized finished event" body into a local helper so both the SSE branch and the fleet branch call it.
  - Read the Core registry (via `useCores()` from `~/queries` — already used elsewhere) to look up `coreAlias` per event.
  - Extend the handler shape: currently keyed on `id/projectId`; must also carry `coreId` (and `coreAlias` for the body). Include `coreId` in the stored `SessionFinishNotification` and in the OS-notification `title`/`body`.
  - Update the toast body: `Session finished — {projectName}` for loopback (unchanged); `Session finished — {projectName} on {coreAlias}` when `coreId !== LOOPBACK_CORE_ID`.
  - Extend the `pruneNotifications` targets (existing task/project/worktree deletion handlers) so remote-Core mutations coming over `fleet.onEvent` also prune. Deletions travel as `project:deleted` / `task:deleted` / `worktree:deleted` event kinds on the same stream — parse `event.payload` and route to `pruneNotifications` scoped to the same `coreId`.

- `src/lib/session-notification-store.ts`
  - Add `coreId: string` (required) and `coreAlias: string | null` (optional cached label) to `SessionFinishNotification`.
  - Add `coreId` to `PendingNotificationOpen` so the "click to open" path can navigate to the right Core in Fleet view.
  - Extend `toSessionFinishNotification` parser to read `coreId` from stored records, defaulting to `LOOPBACK_CORE_ID` for records written by older Panels.
  - Extend `mergeSessionFinishNotification` dedup filter from `(kind, id, projectId)` to `(kind, coreId, id, projectId)` so the same `sessionId` on two different Cores does not collapse.
  - Extend prune predicates in `notificationMatchesPruneTarget`: add `coreId` to `SessionNotificationPruneTarget` variants (task/project/worktree). Loopback-origin events pass `coreId = LOOPBACK_CORE_ID`.

- `src/lib/os-notifications.ts` + `electron/session-finish-notification.ts`
  - Extend `SessionFinishOsNotificationPayload` with `coreId: string` and `coreAlias: string | null`. Main-process code composes the body: `${projectName}${coreAlias ? ` on ${coreAlias}` : ""}\n${taskTitle}` (or use `title` for the "on {alias}" suffix — see UI section).
  - `subscribeSessionFinishOsNotificationClick` payload extended to include `coreId` so the renderer can route to the right Fleet-view scope.

- `src/server/events.ts` and `src/server/services/tasks.ts` — **no change**. Loopback `session:finished` continues to emit the same shape; the hook synthesizes `coreId = LOOPBACK_CORE_ID` at consumption time.

- `RemoteCoreDialer.onEvent` — **no change**. Already surfaces `{ coreId, event }` for every Core; already forwards `session:finished` frames. Grep confirmation: `electron/remote-core-dialer.ts` `onEvent` fans every `client.onEvent` payload; `electron/__tests__/pty-core-link.test.ts` line 941 exercises a `session:finished` event round-trip.

## New pieces (if any)

None strictly required. Prefer extending the existing hook. If the SSE + fleet event normalization grows past ~30 lines, factor a private helper `normalizeSessionFinishedEvent(source: "sse" | "fleet", raw): NormalizedFinish | null` inside `use-session-finish-notifications.tsx` (not a new file, not a new hook).

Interface sketch (private):

```ts
type NormalizedFinish = {
  coreId: string;
  coreAlias: string | null;
  eventId: number | null; // null for SSE (loopback)
  sessionId: string;
  projectId: string;
  worktreeId: string | null;
  scopeId: string;
  projectName: string;
  taskTitle: string;
};
```

## Schema changes

None. Notifications are `localStorage`-only (`mc:sessionFinishNotifications`); there is no SQLite `session_notifications` table today. The `coreId` / `coreAlias` fields are added to the in-memory shape and the JSON-serialized `localStorage` blob only.

Registry-level `lastEventId` per Core is already persisted (`electron/core-registry-store.ts` via `updateCoreLastEventId`, wired through `RemoteCoreDialer.updateCursor`). No new columns.

## Migration

No SQL migration. `localStorage` records written by older Panels lack `coreId`; the parser (`toSessionFinishNotification`) defaults `coreId` to `LOOPBACK_CORE_ID` and `coreAlias` to `null` on read. First write after upgrade rewrites the record with the new fields. No user-visible migration step.

If future spec work moves notifications to SQLite: `NNNN_add_core_id_to_session_notifications.sql` would `ALTER TABLE session_notifications ADD COLUMN core_id TEXT NOT NULL DEFAULT 'loopback'` and `ADD COLUMN core_alias TEXT`. Out of scope here.

## Event dedup

Key: `${coreId}::${sessionId}::${eventId ?? "sse"}`.

Predicate (exact):

```ts
function dedupKey(n: NormalizedFinish): string {
  return `${n.coreId}::${n.sessionId}::${n.eventId ?? "sse"}`;
}
```

Maintain a bounded LRU `Set<string>` in the hook (module-scope, cap 500 keys, drop-oldest on overflow). On every normalized finish event: if the key is present, drop; else insert and dispatch.

Why the `?? "sse"` fallback: loopback SSE lacks an `eventId`. The store's existing `mergeSessionFinishNotification` also collapses `(coreId, sessionId, projectId)` duplicates, so a duplicate loopback SSE is idempotent at the store layer even without the eventId — the dedup set covers the fast-path (toast/ding/OS notification) so the user never sees two toasts for one finish.

Remote replay tails always carry a real `eventId`, so `(coreId, sessionId, eventId)` is fully unambiguous for the remote path.

## Reconnect / replay

- `PtyCoreLinkClient` maintains `lastEventId` per Core in the Core registry (`electron/core-registry-store.ts`, updated via `RemoteCoreDialer.updateCursor` inside the `onEvent` handler in `electron/remote-core-dialer.ts`). On reconnect the Harness streams the tail past `lastEventId` and the same `onEvent` fanout fires again for each replayed event.
- The finish-notification hook does **not** need a separate "seen this before" check — replay tail events flow into the same normalized-finish pipeline, and the `(coreId, sessionId, eventId)` dedup set collapses any that were already delivered live. A Panel that was asleep during a remote finish will fire the toast on wake (first delivery); a Panel that saw the live event and reconnects will drop the replay copy.
- Loopback has no reconnect concept in this sense (in-process events; SSE reconnect just resumes live). Nothing to add.

## OS notifications

- Permission model unchanged: `electron/notification-permissions.ts` still just allow-lists the `notifications` web permission; the audio-capture gate is orthogonal. Nothing to modify there.
- Native notification path (`electron/session-finish-notification.ts` — main-process `Notification`) is Panel-side and OS-agnostic to the origin Core. A remote-origin finish renders through the same `Notification` API on the Panel's OS; the remote Harness never touches OS-notification APIs.
- Body composition moves to the renderer (`useSessionFinishNotifications`) which passes a pre-composed `title` / `body` including the Core alias; main-process code just displays what it's given.
- Click routing: `notification.on("click", …)` restore/show/focus behavior is unchanged; the `onSessionFinishedClick` payload gains `coreId` so the renderer can route into the right Fleet-view scope.

## Settings

No new settings. The two existing toggles remain the entire surface:

- `sessionFinishToastEnabled` (default `true`) — gates the in-app toast.
- `sessionFinishOsNotificationEnabled` (default `false`) — gates the OS-level notification.

Both are read from `useSettings()` in the hook and honored identically for loopback and remote origins. `notificationSoundEnabled` continues to gate the ding.

## UI

- Toast body format:
  - Loopback: `Session finished — {projectName}` (unchanged), subtitle `{taskTitle}`.
  - Remote: `Session finished — {projectName} on {coreAlias}`, subtitle `{taskTitle}`. Fallback: if `coreAlias` is null/empty, use the raw `coreId`.
- OS notification body:
  - Loopback: title `Session finished — {projectName}`, body `{taskTitle}`.
  - Remote: title `Session finished — {projectName} on {coreAlias}`, body `{taskTitle}`.
- Notifications list (via `SessionNotificationsButton`) shows the Core alias inline as a small badge next to the project name; empty state is unchanged.
- Click behavior:
  - Loopback: unchanged — `router.navigate({ to: "/projects/$id", params: { id: projectId } })` and enqueue a `PendingNotificationOpen` so the project route materializes the session.
  - Remote: navigate to the Fleet-view scope for `coreId` (existing route accepts `coreId` search param — see `FleetView.tsx`), then open the project scoped to that Core. `PendingNotificationOpen` gains `coreId` for the target route to consume.

## Tests

- Unit: `dedupKey` predicate — asserts distinct keys for `(coreA, s1, 5)` vs `(coreA, s1, 6)` vs `(coreB, s1, 5)`; asserts SSE loopback with `null` eventId dedups against itself.
- Unit: `session-notification-store.ts` — extend `mergeSessionFinishNotification` tests to prove two Cores with the same `sessionId` produce two rows; old records without `coreId` parse with `LOOPBACK_CORE_ID` default; prune targets scoped by `coreId` don't cross-delete.
- Unit: `toSessionFinishNotification` backfill — a stored record without `coreId` deserializes with `coreId = LOOPBACK_CORE_ID`, `coreAlias = null`.
- Integration: fake `electron.fleet.onEvent` emits a synthesized remote `session:finished` frame → hook fires exactly one toast with `on {coreAlias}` in the title, one OS notification when the setting is on, one stored notification with `coreId = "core_a"`.
- Integration: reconnect replay tail — emit a remote finish live, then re-emit the same `(coreId, eventId)` after a simulated reconnect → exactly one toast delivered.
- Integration: loopback finish still fires a toast whose title has no ` on ` suffix; regression test on the existing shape.
- Integration: click-through — clicking a remote notification enqueues a `PendingNotificationOpen` with the correct `coreId` and drives navigation into the Fleet view scoped to that Core.

## Verification checklist

- Remote-Core Session finish triggers exactly one Panel toast on the Panel's machine, with `on {coreAlias}` in the title.
- Loopback Session finish continues to fire an identical toast to before (no `on …` suffix), no regression to sound/OS behavior.
- OS notification (when enabled) includes the Core alias for remote origins and omits it for loopback.
- Panel sleep during a remote finish: waking + reconnect delivers the missed notification exactly once (replay tail), no duplicates.
- Two Cores that happen to reuse the same session id do not collapse to a single stored notification.
- `sessionFinishToastEnabled = false` suppresses toast for both loopback and remote; `sessionFinishOsNotificationEnabled = false` suppresses OS notification for both. Sound toggle honored uniformly.
- Deleting a project/task/worktree on a remote Core prunes the corresponding remote-origin notifications from the store (scoped by `coreId`), without touching loopback rows.
- Clicking a remote notification navigates to Fleet view scoped to the origin Core and opens the session; clicking a loopback notification behaves exactly as before.

## Follow-ups / out of scope

- Cross-Core notifications for other kinds — `Core became unreachable`, `Core reachable again`, `Harness update available`, `mTLS cert nearing expiry`. These follow the same Panel-side subscription pattern but originate from `RemoteCoreDialer.onStatus` (not `onEvent`) and warrant their own event-kind design + settings toggles. Out of scope here.
- Server-side (SQLite) notification persistence: motivated when we want cross-tab / cross-Panel-restart continuity beyond the 200-item `localStorage` cap or beyond a single Panel install. Out of scope; sketch above.
- Per-Core notification muting (e.g., "silence the staging VM Core") — a per-`coreId` toggle in the Cores settings page. Out of scope; ADR 0008 explicitly holds new settings back.
- Notification grouping when many Sessions finish in a burst (e.g., a fleet-wide "5 sessions finished on prod-vm-1" collapsed toast). Out of scope.
