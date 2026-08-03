# 05 — Harness `install` command: registration blob emission + systemd/launchd auto-start

**What to build:** A `harness install` command (and a one-line `curl …/install | bash` entry point) provisions a fresh machine into a Harness: it generates the mTLS material (self-signed CA + certs + signed bearer), starts the daemon listening on a configured port, and prints a single base64 registration blob to the terminal for the operator to paste into the Panel. The install detects the host init system and writes a service unit — systemd on Linux, launchd on macOS — so the daemon survives reboots and resumes running agents without an operator SSHing in. Re-running `harness install` reissues the registration blob while preserving the existing SQLite/tasks.

**Blocked by:** 04 — needs the cert generation + blob format + `wss://` mTLS defined by the remote-dial ticket.

**Status:** ready-for-agent

- [ ] `harness install` (or `curl …/install | bash`) generates certs + bearer, starts the daemon, and prints a base64 registration blob.
- [ ] The blob is `{endpoint, caCert, clientCert, clientKey, bearer}` and is accepted by the Panel's "Add Core" from ticket 04.
- [ ] On Linux the install writes a systemd unit; on macOS it writes a launchd plist, so the daemon auto-starts on boot.
- [ ] A rebooted VM resumes running its Harness: the Panel reconnects and replays events from `lastEventId`.
- [ ] Re-running `harness install` reissues the registration blob without losing existing tasks/sessions/SQLite.
