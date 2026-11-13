# Session states

A Task's `sessionState` says what its Session is doing. It is `null` when no attempt runs. **The result file is the only success signal**: a Session state never changes a Task's `status`. Only the Agent's result file makes a Task `done`, `failed` or `partial`.

| `sessionState` | Meaning | What to do |
|---|---|---|
| `working` | The Agent is busy. | Keep waiting on `watch.url`. |
| `needs-input` | The Session waits for a person: the Agent asked a question or hit a dialog. | Read the Task with `get_task`. If the Agent asked a question you can answer, answer with `comment_task`. Otherwise tell the Operator. |
| `interrupted` | The Session was interrupted. | Read the Task, then continue with `comment_task` and `reassign: true`, or tell the Operator. |
| `idle-no-result` | The Session is idle and has written no complete result file. | Read the Task and its comments. If the work is not done, send it back with `comment_task` and `reassign: true`. |
| `exited` | The Session ended. | Read the Task: a result file may exist. If none does, the attempt failed; comment and re-assign if it should go on. |

`get_tasks` takes `sessionState` (one value or a comma list) to list, for example, every Task that is `needs-input`.

A state can pass: a Task that is `needs-input` may be answered by someone else a moment later. Read the Task again before you act.

## Statuses

`status` is the Task's own: `draft`, `assigned`, `in_progress`, `done`, `failed`, `partial`. Operators only move a Task between draft and assigned (`assign_task`); the dispatcher and the Agent's result do the rest.
