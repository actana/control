# Panel link: one multiplexed WebSocket between browser and Panel

With every core-link terminating inside the Panel service (browsers cannot hold mTLS client certificates — ADR 0002), the Panel UI needs its own live transport. Each Panel session opens **one multiplexed WebSocket — the panel link** — carrying `coreId`-tagged frames for all Cores at once: PTY streams, events, mutations, dial statuses. The frame design mirrors the core-link protocol (same framing, replay-by-cursor, reconnect semantics), with the Panel acting as a router: browser frames are fanned to the right core-link and Core events are fanned back tagged with their `coreId`. SSR covers first paint; the panel link carries everything after it.

Rationale: the core-link protocol already solved framing, ordered replay, and reconnect — reusing its shapes means one connection to manage, one cursor to replay, and symmetry a maintainer can hold in their head. The UI already talks through a structural `PtyLike`/bridge seam, so the panel link becomes a third implementation of an existing interface rather than a UI rewrite.

Session-finished notifications ride the same events, phased: **v1** uses the browser Notification API — fires whenever a Panel tab is open (even backgrounded), click focuses the tab and jumps to the session; **later** a service worker + Web Push (VAPID) delivers with the browser closed, which also unlocks phone notifications once the Panel is reachable from a phone. Push is additive on top of the event stream, so it does not gate the extraction.

## Considered Options

- **REST + SSE for events, one WebSocket per open terminal (rejected).** N connections to reconnect and order against each other; the multi-terminal grid is the common case, not the edge case.
- **REST polling (rejected).** Terminal streams make it a non-starter.
- **A second, browser-flavored protocol (rejected).** Two frame vocabularies for the same domain events; the whole point of the router design is that frames pass through with a `coreId` stamp.
