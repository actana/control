# Session states

A Task's `sessionState` says what its Session is doing. It is `null` when no attempt runs. **The result file is the only success signal**: a Session state never changes a Task's `status`. Only the Agent's result file makes a Task `done`, `failed` or `partial`.

| `sessionState` | Meaning | What to do |
|---|---|---|
| `working` | The Agent is busy. | Keep waiting on `watch.url`. |
| `needs-input` | The Session waits for a person: the Agent asked a question or hit a dialog. | Read the Task with `get_task`. If the Agent asked a question you can answer, answer with `comment_task`. Otherwise tell the Operator. |
| `interrupted` | The Session was interrupted. | The Task is still `in_progress`: a Session state never moves its `status`. If you created the Task, `stop_task` it, then `comment_task` with `reassign: true` to continue. Otherwise tell the Operator. Do not stop a Task you did not create. |
| `idle-no-result` | The Session is idle and has written no complete result file. | Read the Task and its comments. The Task is still `in_progress`. If the work is not done and you created the Task, `stop_task` it, then send it back with `comment_task` and `reassign: true`. Otherwise tell the Operator. Do not stop a Task you did not create. |
| `exited` | The Session ended. | Read the Task: a result file may exist. If none does, the attempt failed; comment and re-assign if it should go on. |

`get_tasks` takes `sessionState` (one value or a comma list) to list, for example, every Task that is `needs-input`.

A state can pass: a Task that is `needs-input` may be answered by someone else a moment later. Read the Task again before you act.

## Statuses

`status` is the Task's own: `draft`, `assigned`, `in_progress`, `done`, `failed`, `partial`. Operators only move a Task between draft and assigned (`assign_task`); the dispatcher and the Agent's result do the rest.
