# 05 — Agent CLI detection and offers

**What to build:** The install becomes genuinely one-stop: during `actana setup` on a TTY, each missing agent CLI (claude, opencode, …) gets a per-agent "install it? [Y/n]" offer, executed via the vendor's official install method. Non-interactive runs use `--with-<agent>`, `--no-agents`, `--yes`. After install, `actana agents install <id>` performs the same offer on demand. The Harness's own availability probing remains the source of truth — after any install, availability refreshes so a paired Panel sees the new agent without restarts.

**Blocked by:** 02 — `actana setup` + lifecycle verbs (Linux).

**Status:** ready-for-human

- [x] Fresh container: setup detects missing agents, offers each, and an accepted offer leaves a working vendor-installed CLI on PATH
- [x] `--with-<agent>` installs unattended; `--no-agents` skips all offers; non-TTY never prompts
- [x] `actana agents install <id>` works post-install; unknown ids fail with the supported list
- [x] A vendor installer failure is reported clearly and does not fail the Harness install itself
- [x] Harness availability reflects newly installed agents without a daemon restart (or restarts transparently)
