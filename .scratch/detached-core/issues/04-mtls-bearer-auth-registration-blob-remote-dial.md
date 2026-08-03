# 04 — mTLS + bearer auth on the core-link; "Add Core" via registration blob; first real remote dial

**What to build:** The core-link becomes `wss://` with mutual TLS — a self-signed CA is generated at Harness start, the Harness holds a server cert, the Panel holds a pinned client cert, both signed by that CA. After the mTLS handshake the Panel presents a signed bearer `{coreId, exp, sig}` in an `auth` frame; the Harness validates `exp` and closes on expiry; the Panel re-handshakes TLS and reconnects, draining missed events via `lastEventId` (the same path as Panel-sleep recovery). The Panel's "Add Core" accepts a single paste of a base64 registration blob (`{endpoint, caCert, clientCert, clientKey, bearer}`), parses it, stores secrets in `safeStorage`, and dials the Core. This is the remote tracer bullet — the moment a Harness on a different machine is actually drivable from the Panel.

**Blocked by:** 02 — needs the generalized protocol + event-replay path for reconnect-on-expiry. 03 — needs the Core registry to store the new Core.

**Status:** ready-for-agent

- [ ] Harness generates a self-signed CA + server cert at start; the core-link is `wss://` with mTLS.
- [ ] The Panel pins the CA + client cert (stored in `safeStorage` via the Core registry) and rejects unknown CAs.
- [ ] After mTLS, the Panel presents a signed bearer with `exp` in an `auth` frame; the Harness validates it and closes on expiry.
- [ ] On expiry the Panel re-handshakes TLS and reconnects, replaying events from `lastEventId` (no rolling renewal over the live socket).
- [ ] "Add Core" accepts a paste registration blob, parses it, stores secrets in `safeStorage`, dials `wss://`, and the Core appears.
- [ ] Running the Harness on a second machine (or second port) and pasting its blob lets the Panel see that remote Core's projects/tasks; a Panel restart reconnects and replays.
