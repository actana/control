# 09 — Docker image, reference compose, config surface

**What to build:** The Panel ships as a Docker image: one container serving plain HTTP, all state in one mounted data volume, configured by environment (port, data dir, `AC_SECRETS_KEY`). A reference `docker-compose.yml` pairs it with a TLS-terminating proxy (automatic Let's Encrypt) so "hosted with HTTPS" is copy-paste; `localhost` use needs no proxy. Docs cover the compose path, the bare `node` path, backup (= the volume), and upgrade (= pull new image, restart).

**Blocked by:** 08 — Electron teardown.

**Status:** ready-for-agent

- [ ] `docker compose up` on a clean machine yields a reachable Panel: first-boot setup → login → pair a Core over HTTPS
- [ ] All persistent state survives container recreation via the single volume; image upgrade preserves data
- [ ] Secure cookies and the panel link (wss) work correctly behind the reference proxy
- [ ] The same build runs as a plain `node` process with documented env config
- [ ] Image built in CI on release; no Electron artifacts in any release output
