# 03 — Pair a Core: registry, secrets at rest, server-side dialing

**What to build:** "Add Core" in the browser accepts a pasted pairing token (Registration blob); the Panel service stores the endpoint/label in the Core registry, encrypts the secrets (CA, client cert/key, bearer) with an auto-generated key file in the data directory (overridable via `AC_SECRETS_KEY`), and dials the Core over mTLS from the service — whether or not any browser is open. Dial status (connected / unreachable + last-seen) is visible in the UI. Per-Core `lastEventId` cursors are owned by the Panel service. Removing a Core drops its registry row, secrets, and cursor.

**Blocked by:** 02 — Panel service boots standalone.

**Status:** done — on branch `wt-e03` (2026-07-31), not merged

- [x] Pasting a valid pairing token registers the Core and a live dial reaches the Harness (mTLS + bearer, per ADR 0002)
- [x] Secrets are unreadable in the database without the key file; `AC_SECRETS_KEY` overrides the key file when set
- [x] Dial status renders in the fleet UI and updates on connect/disconnect; reconnection uses the Panel-owned cursor
- [x] Core links live entirely in the service: they dial with no Panel session open and survive browser closes
- [x] An invalid or corrupted pairing token yields a clear UI error and no partial registry state
- [x] Removing a Core cleans registry, secrets, and cursor

## Notes

- The core-link client and its Node mTLS socket factory moved out of `electron/`
  into `packages/panel/src/server/core-link/` — the parent spec's "core-link
  clients move wholly server-side". `electron/` imports them from there until
  its teardown (08). The client gained `onDisconnected`, which is what lets a
  Core that is simply off read as unreachable instead of sitting at
  "connecting" for as long as the backoff runs.
- Secrets are AES-256-GCM. The key is `<data dir>/secrets.key` (0600,
  auto-generated) or `AC_SECRETS_KEY` (32 bytes, hex or base64) — documented in
  `packages/panel/bin/panel.mjs`.
- The cursor is a column on the `cores` row, so removing a Core takes it along.
  The client persists through the registry-backed `storage` seam the manager
  hands it; `cores-api.test.ts` proves the Harness replays from the stored
  number after a service restart, against a real `wss://` Harness.
- Dial status renders on Settings → Cores, polled every 3s. Pushing it over the
  panel link, and surfacing it in Fleet view, is 04's — the manager
  deliberately exposes no status-subscription seam until 04 has a consumer.
