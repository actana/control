# Comments and re-assigning

The Task's thread is its conversation with the Agent. The Agent's report arrives there as a comment; `get_task` returns the whole thread.

## Comment

`comment_task({ taskId: "task-id", body: "Use the staging database, not production." })` adds a comment. On a finished Task it changes nothing by itself. A comment is a note the Session does not see unless you send it with `deliver: "now"` into a running Session; that is refused while the Session is `needs-input` (answer those with `answer_task`).

## Comment and re-assign

`comment_task({ taskId: "task-id", body: "The test still fails; check the retry path.", reassign: true })` sends a finished Task back to its Agent with your comment. The answer carries `sessionState` and a new `watch.url` straight away: wait on that, as in the `waiting` topic.

- A Task that is `in_progress` is refused: `stop_task` it first (only if you created it), then comment again with `reassign: true`.
- The old `watch.url` ends when a new attempt starts: use the new one.

## Edit instead of comment

`update_task` changes a Task's title and description while it is not `in_progress`; the time limit (`timeoutMinutes`) can change at any status. To change the instructions of a running Task, comment instead.
