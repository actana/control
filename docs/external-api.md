# The HTTP surfaces

Actana Control has two HTTP surfaces, and neither is a public integration API.
This page says what they are, so nobody has to guess from a port number.

> **History.** The root README used to document a Core API of
> `POST /api/projects/:id/tasks` and `POST /api/tasks/:id/status`, guarded by a
> token from `actana status`. **That design is retired and those routes do not
> exist.** Task and project writes now travel as core-link mutation frames, not
> HTTP ([ADR 0004](adr/0004-core-owns-write-path.md)); the Core's only HTTP
> surface is the hook receiver below. The old text is corrected here rather
> than carried forward.

## A Core's hook receiver

Each Core runs a small HTTP server so that the harnesses it spawns can report
what they are doing. It is not an operator-facing API and there is nothing to
configure — the Core writes the hook entries into each harness's own config and
hands the credentials to the process in its environment.

| Property | Value |
| --- | --- |
| Bind address | `127.0.0.1` only — never the Core's public host |
| Port | Ephemeral (`listen(0)`), chosen by the OS at boot |
| Route | `POST /api/hooks/<slug>?taskId=…&hookEvent=…` |
| Auth | `Authorization: Bearer` — 32 random bytes minted **per boot**, held in memory, never persisted |
| Delivered as | `AC_HOOK_URL`, `AC_HOOK_TOKEN`, `AC_HOOK_TASK_ID` in the PTY's environment |

The command the Core writes into a harness's hook config reads the secret from
the environment rather than embedding it, so the config file on disk carries
nothing worth stealing:

```sh
curl -sS -m 3 -X POST \
  -H "Authorization: Bearer $AC_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "$AC_HOOK_URL/api/hooks/<slug>?taskId=$AC_HOOK_TASK_ID&hookEvent=<event>"
```

A restart mints a fresh token, so a hook from a previous boot's PTY fails
auth — which is correct, because that session's process is gone.

## The Panel's own routes

The Panel's `/api/*` surface exists to serve its own browser tab. It is
authenticated by the Operator's session cookie, which the browser attaches on
its own ([ADR 0011](adr/0011-operator-identity-and-panel-auth.md)) — there is no
bearer-token mode and no versioning promise. Harnesses never call it.

Task, project and session **reads and writes do not appear here**: they travel
over the panel link as core-link frames, because each Core owns that state
(ADR 0004). What is left is the Panel's own concerns:

| Area | Routes |
| --- | --- |
| Liveness | `GET /api/healthz` |
| Operator auth | `/api/auth/state`, `/api/auth/setup`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/password` |
| Core registry | `/api/cores` |
| Panel-side project presentation | `/api/projects`, `/api/projects/pinned-order`, `/api/project-presentation`, `/api/project-presentation/prune`, `/api/groups`, `/api/groups/order` |
| Preferences | `/api/settings`, `/api/keybindings`, `/api/home/user-terminals` |
| Usage and providers | `/api/usage`, `/api/provider-usage`, `/api/claude-usage-limits`, `/api/ai-runtime/models`, `/api/harness-launchers/accounts`, `/api/harness-launchers/latest-versions` |
| Live updates | `GET /api/events` (SSE) |
| Release check | `GET /api/update-check` |

`api-router.ts` is the authority; treat this table as a map, not a contract.

## Skill file for external CLIs

A drop-in skill for Claude Code / Codex / Cursor CLI lives in
[`skills/missioncontrol-notify.md`](skills/missioncontrol-notify.md). Paste it
into the CLI's instructions or memory so the harness knows to report its
lifecycle events back to Actana Control.

## See also

- [Observability](observability.md) — where a Panel's and a Core's logs land
- [`../DEPLOY.md#configuration`](../DEPLOY.md#configuration) — every environment variable
