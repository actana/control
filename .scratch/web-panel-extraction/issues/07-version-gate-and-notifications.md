# 07 — Version gate + session-finished browser notifications

**What to build:** Two operator-facing behaviors riding the panel link. (1) The core-link handshake exchanges a protocol version; a mismatched Core renders as "needs update" in Fleet view with the exact update command to copy, and its data paths are suppressed — no degraded mode, no feature detection (ADR 0005). (2) Session-finished Events surface as browser Notification API notifications from any open Panel tab (even backgrounded); clicking one focuses the tab and jumps to that session. In-app toasts and sounds keep working. Permission is requested from a settings affordance, never on page load.

**Blocked by:** 04 — Panel link + live read path.

**Status:** ready-for-agent

- [ ] A Harness speaking an older protocol version shows "needs update" + copyable command; its projects/tasks/terminals are not rendered
- [ ] A matching Core is unaffected; version state updates live when the Core is updated and reconnects
- [ ] With notifications granted and the tab backgrounded, a finishing session raises an OS-level notification via the browser
- [ ] Clicking the notification focuses the Panel tab and navigates to the finished session's Core + Task
- [ ] Denied/undecided permission degrades silently to in-app toasts
