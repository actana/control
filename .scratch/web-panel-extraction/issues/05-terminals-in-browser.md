# 05 — Terminals in the browser

**What to build:** TerminalPane works end to end in the browser: PTY spawn/write/resize/kill flow browser → panel link → Panel router → core-link → Harness, and output streams back through the same path into xterm. Includes agent session terminals, VM Shell Sessions (still gated behind an explicit open gesture), and terminal reattach after a panel-link drop — reconnect resumes the stream with replayed scrollback, no duplicated or lost output.

**Blocked by:** 04 — Panel link + live read path.

**Status:** ready-for-agent

- [ ] Spawning an agent session from the browser opens a live streaming terminal against the Core
- [ ] Keystrokes, resize, and kill round-trip correctly; multiple concurrent terminals share the one panel link
- [ ] VM Shell Session opens only via explicit gesture and works like any terminal
- [ ] Killing the panel link mid-session then reconnecting reattaches the terminal with replayed history
- [ ] A second tab can open the same Task's terminal and both render the stream
