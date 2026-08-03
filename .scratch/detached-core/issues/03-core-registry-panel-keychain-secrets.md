# 03 — Core registry in the Panel (add/list/remove Cores, keychain secrets)

**What to build:** The Panel gains a local Core registry — a store of the Cores it can talk to, holding `{endpoint, label}` plus secrets (certs/tokens) encrypted at rest via `safeStorage` (macOS keychain / OS equivalent). The loopback Core from ticket 01 auto-registers as the first entry so the existing app keeps working. The Panel surfaces a UI to view, add, and remove Cores. The registry is the only task-adjacent state the Panel owns; it holds nothing about tasks, sessions, or projects (those live on the Harness).

**Blocked by:** 01 — needs the server to be a dialable "Core" for the loopback entry to be meaningful.

**Status:** ready-for-agent

- [ ] The Panel persists a Core registry locally: `{endpoint, label}` in plaintext, secrets in `safeStorage`.
- [ ] The loopback Core auto-registers as the first entry on first run, so existing behaviour is preserved.
- [ ] UI lists registered Cores and supports adding/removing an entry.
- [ ] Removing a Core disconnects its core-link and frees its resources but does not touch any Harness-side state.
- [ ] No task, session, project, or event state is stored on the Panel.
