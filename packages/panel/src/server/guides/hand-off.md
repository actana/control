# Handing a Task off

## Choose the Core and the Agent

- `list_cores` shows the Cores your key reaches, with `liveSessions` against `maxSessions`. A Core at its limit queues the Task: it starts by itself when a slot frees.
- `list_agents` shows the Agents. A Task names one Agent by its id (`agent`) and that Agent's Core (`coreId`). Create one with `create_agent` only if none fits.

## Create and start in one call

`create_task({ title: "Fix the flaky login test", description: "What to do, in Markdown", coreId: "core-id", agent: "agent-id", startNow: true })`

- The answer comes straight back with `watch.url` and `sessionState`. Do not call `get_task` to get them.
- Without `startNow` the Task is a draft: nothing runs and there is no watch. Start it with `assign_task({ taskId: "task-id", status: "assigned" })`, which also returns `watch.url`.
- `timeoutMinutes` sets the time limit per attempt (default 60; `null` means no limit).
- Put everything the Agent needs in `description`: it only sees that text and the comments.

## Queued Tasks

If the Core is full or not connected, the answer says so (`queued`, `waiting`). Still use `watch.url`: it stays valid across the queue wait and follows the attempt once it starts.

## When a call times out or fails

A timeout does not prove non-delivery: read the Task before you resend. The Panel may have created and started the Task before your client gave up. List with `get_tasks` (filter by `status` or `coreId`; its rows have no description), read one Task's brief with `get_task`. Ask `get_tasks` for `withDescriptions` only with a small `limit`. Only create a second Task when the first one is not there.

## After the Task settles

Read it with `get_task`: the Agent's report is a comment. `close_session` ends the harness of a Task that is no longer in progress and frees the Core's slot, so a queued Task can start. The Session stays and `comment_task` with `reassign: true` continues it.
