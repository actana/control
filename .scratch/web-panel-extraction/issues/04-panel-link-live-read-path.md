# 04 — Panel link + live read path

**What to build:** Each authenticated browser tab opens one multiplexed WebSocket — the panel link (cookie presented at upgrade) — carrying `coreId`-tagged frames mirroring core-link framing (ADR 0012). The Panel service routes: Core events, dial-status changes, and CLI-availability snapshots fan in to the browser; queries fan out to the right core-link. Fleet view and Per-Core navigation (project rail → SessionGrid) render live data from a real Core in the browser, updating without refresh. The UI reaches all of this through the reshaped bridge interface (web implementation), keeping component call sites intact.

**Blocked by:** 03 — Pair a Core.

**Status:** ready-for-agent

- [ ] One WS per tab regardless of how many Cores are registered; upgrade rejected without a valid session
- [ ] Fleet view shows all Cores with live status; an unreachable Core shows last-seen and no task rows
- [ ] Per-Core navigation lists projects and tasks from the Harness live; changes on the Harness appear without refresh
- [ ] Frames are `coreId`-enveloped reuses of core-link shapes — no second protocol vocabulary
- [ ] Panel-link drop → automatic reconnect → missed events replayed from cursor, none lost
- [ ] Two simultaneous tabs both receive consistent live state
