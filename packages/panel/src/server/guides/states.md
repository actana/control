# Session states

A Task's `sessionState` says what its Session is doing. It is `null` when no attempt runs. **The result file is the only success signal**: a Session state never changes a Task's `status`. Only the Agent's result file makes a Task `done`, `failed` or `partial`.

| `sessionState` | Meaning | What to do |
|---|---|---|
| `working` | The Agent is busy. | Keep waiting on `watch.url`. |
| `needs-input` | The Session waits at a prompt: the Agent asked a question or hit a dialog. | Read the Task with `get_task` and answer it with `answer_task` (see below). Escalate what you may not answer. |
| `interrupted` | The Session was interrupted. | The Task is still `in_progress`: a Session state never moves its `status`. If you created the Task, `stop_task` it, then `comment_task` with `reassign: true` to continue. Otherwise tell the Operator. Do not stop a Task you did not create. |
| `idle-no-result` | The Session is idle and has written no complete result file. | Read the Task and its comments. The Task is still `in_progress`. If the work is not done and you created the Task, `stop_task` it, then send it back with `comment_task` and `reassign: true`. Otherwise tell the Operator. Do not stop a Task you did not create. |
| `exited` | The Session ended. | Read the Task: a result file may exist. If none does, the attempt failed; comment and re-assign if it should go on. |

`get_tasks` takes `sessionState` (one value or a comma list) to list, for example, every Task that is `needs-input`.

A state can pass: a Task that is `needs-input` may be answered by someone else a moment later. Read the Task again before you act.

## A Task that needs input: answer it or escalate

You are responsible for every input a Task's Session asks for. A person is needed only for what you cannot answer.

1. `get_task({ taskId })`. While the Session is `needs-input` the Task has `prompt: { text, options?, kind, at }`: `text` is what the screen shows, `kind` is `question`, `choice`, `confirm`, `permission`, `trust` or `unknown`, `options` are the choices, and `at` is the id of this prompt.
2. Answer what follows from the Task's brief: an obvious question, a choice, a confirmation. `answer_task({ taskId, answer: { option: 2 }, expect: at })`, or `answer: { text: "staging" }` (typed, then Enter), or `answer: { keys: ["y", "Enter"] }` (Enter, Esc, Up, Down, Left, Right, Tab, Space, y, n, 1-9). Always pass `expect` with the `at` you read: if the Session asks something else by then you get `stale_prompt` and nothing is typed; read the Task again.
3. On `unknown` (the Panel could not tell what the dialog is) only `keys` is accepted. Read `text` carefully before you press anything.
4. **Escalate, never guess:** a `trust` prompt (trust a folder), anything that asks for a password, token or credential, and a `permission` prompt that would widen the Agent's access are refused with `needs_human`. Nothing is typed. Tell the Operator in your own output (the Task also raised the needs-input notification) and wait for them to answer in the Session. Do not look for another way to type it.
5. Each answer adds a Task comment, `Answered by <you>: <kind> "<prompt>" → <answer>`. Then wait again on `watch.url`: the state goes back to `working`, or to a new `needs-input` with a new `at`.

If `answer_task` says `not_waiting`, the Session moved on: read the Task again.

## Statuses

`status` is the Task's own: `draft`, `assigned`, `in_progress`, `done`, `failed`, `partial`. Operators only move a Task between draft and assigned (`assign_task`); the dispatcher and the Agent's result do the rest.
