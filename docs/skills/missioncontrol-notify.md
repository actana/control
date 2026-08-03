---
name: missioncontrol-notify
description: When you finish a task, hit a question, or fail, POST your status to the Actana Control desktop app so the user sees it without checking your terminal.
---

# Actana Control status hook

You are running inside a terminal launched by Actana Control. There is a task ID associated with this run, and a localhost API you can call to update the user's mission-control board.

## How to find your credentials

Two values you need:

- `MC_PORT` — the port Actana Control is listening on
- `MC_TOKEN` — bearer token for the writable API
- `MC_TASK_ID` — the task ID for this terminal

Lookup order:

1. Read environment variables `MC_PORT`, `MC_TOKEN`, `MC_TASK_ID` if set.
2. Otherwise, read `~/Library/Application Support/Actana Control/.port` (macOS) or `~/.config/Actana Control/.port` (Linux) for the port. The token can be copied from the Actana Control Settings page (it stays the same across launches).
3. The task ID is shown in the terminal pane header inside Actana Control. Ask the user if you can't find it.

## When to POST

- **Right after you finish a chunk of work** that's safe to commit/review:
  ```bash
  curl -s -H "Authorization: Bearer $MC_TOKEN" \
    -X POST http://127.0.0.1:$MC_PORT/api/tasks/$MC_TASK_ID/status \
    -d '{"status":"finished","preview":"Refactor complete. Tests green."}'
  ```

- **When you have a blocking question for the user**:
  ```bash
  curl -s -H "Authorization: Bearer $MC_TOKEN" \
    -X POST http://127.0.0.1:$MC_PORT/api/tasks/$MC_TASK_ID/status \
    -d '{"status":"needs-input","preview":"Should I drop sessions older than 24h?"}'
  ```

- **When you resume work** after answering a question:
  ```bash
  curl -s -H "Authorization: Bearer $MC_TOKEN" \
    -X POST http://127.0.0.1:$MC_PORT/api/tasks/$MC_TASK_ID/status \
    -d '{"status":"running","preview":"Resuming on the registry refactor"}'
  ```

- **When you fail or hit a hard error**:
  ```bash
  curl -s -H "Authorization: Bearer $MC_TOKEN" \
    -X POST http://127.0.0.1:$MC_PORT/api/tasks/$MC_TASK_ID/status \
    -d '{"status":"terminated","preview":"node-pty build failed on arm64"}'
  ```

## Status values

- `running` — actively making progress
- `needs-input` — blocked on a user decision
- `interrupted` — user interrupted the agent and it is waiting for revised instructions
- `finished` — task complete, ready for review/commit
- `terminated` — task stopped and won't proceed without intervention
- `disconnected` — Actana Control lost the terminal process

## Optional fields

- `preview` (string) — one-line summary visible on the project card and task card. Aim for under ~80 chars.
- `lines` (number) — running tally of lines changed; appears in the task card metadata row.

## Don't do this

- Don't POST `running` constantly. Once at start is fine; the shimmer animation in the UI takes over.
- Don't include any secrets, env values, or large logs in `preview` — it's user-visible on the home grid.
- Don't expose the bearer token in logs or commit it.
