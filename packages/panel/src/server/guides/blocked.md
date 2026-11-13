# When a Task is stuck

## The Task is waiting

`waiting` on a Task is `{ reason, coreId }`: the Core is full, not connected, or the harness is not ready. Nothing to do but wait, or free a slot with `close_session` on a finished Task.

## Stopping

`stop_task` stops a Task that is `in_progress`: it ends the Session and fails the Task with a system comment, and then `comment_task` with `reassign: true` can send it back.

- Do not stop a Task you did not create. It belongs to someone else's work, and stopping it throws that work away.
- Stop only what you started, and only when the Task is truly stuck: not while it is `working`, and not for `needs-input` (answer or escalate instead).
- The answer says whether the Session was stopped. A Core that is offline leaves it running.

## Refusals

- `delete_task` and `update_task` (title and description) are refused while a Task is `in_progress`; `update_task` can still change the time limit.
- `close_session` is refused with 409 for a Task that is `in_progress` (use `stop_task`), for a Task with no Session, and for a Session someone is working in.
- Time ran out: the Task fails with a system comment; read it and decide whether to re-assign.

## Report what you cannot fix

If a Task cannot go on, say so to the Operator with the Task id and what you read. Do not create a copy of a Task that already exists: check with `get_tasks` first.
