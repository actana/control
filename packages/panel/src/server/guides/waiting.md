# Waiting for a Task

Wait on `watch.url`. It is a plain GET with no API key, cookie or MCP, and it answers a small JSON object:
`{ taskId, attempt, status, sessionState, sessionStateAt, result, updatedAt, pollAfterSeconds }`.
Never loop on `get_task` or `get_tasks`: that costs a full read per turn and can be rate limited.

`watch` itself is `{ url, expiresAt, pollAfterSeconds }`, returned by `create_task`, `assign_task`, `comment_task` (with `reassign`) and `get_task` while an attempt is assigned or running.

## On a Core: `actana task wait`

`actana task wait "<watch.url>"` loops for you: it asks again after `pollAfterSeconds`, honours `Retry-After`, backs off on network errors, and prints one line per state change. Exit codes:

| Code | Meaning |
|---|---|
| 0 | the Task is `done` |
| 10 | `failed` |
| 11 | `partial` |
| 20 | `needs-input`: the Session waits for a person |
| 21 | `interrupted` |
| 22 | `idle-no-result` |
| 30 | the URL is gone (410): expired, replaced by a new attempt, stopped or deleted |
| 31 | `--timeout` ran out |

`--timeout <minutes>` bounds the wait and `--json` prints the last answer.

## Anywhere else: a `curl` loop

Without the CLI, loop yourself and obey the server's pace:

```bash
u='<watch.url>'; h=$(mktemp)
while :; do
  code=$(curl -sS -D "$h" -o "$h.body" -w '%{http_code}' "$u") || { sleep 10; continue; }
  body=$(cat "$h.body")
  case $code in
    200) case $body in *'"result":"'*|*'"needs-input"'*|*'"interrupted"'*|*'"idle-no-result"'*) break;; esac
         s=$(printf %s "$body" | sed -n 's/.*"pollAfterSeconds":\([0-9]*\).*/\1/p')
         sleep "${s:-5}";;                      # the server's own pace
    429) r=$(awk 'tolower($1)=="retry-after:"{print $2+0}' "$h"); sleep "${r:-30}";;
    *)   break;;                                # 410 gone, 404 wrong token
  esac
done
echo "$body"; rm -f "$h" "$h.body"
```

- Sleep `pollAfterSeconds` (from each answer) between reads, not less.
- On `429` wait the `Retry-After` seconds.
- `410` means the URL is over: read the Task with `get_task`.
- `404` means the token is wrong.
- A network error is retried after a pause; give up after about ten minutes without one good answer.
- `exited` does not end this loop: a Session that ended may still have written its result. Stop on your own timeout and read the Task.

## When the wait ends

Read the Task with `get_task`. A non-null `result` in the watch answer means the Agent reported: `done`, `failed` or `partial`. Any other ending is a Session state: see the `states` topic.
