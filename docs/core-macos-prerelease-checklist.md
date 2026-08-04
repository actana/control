# macOS Core — manual pre-release checklist

**CI no longer covers any of this.** It used to: an `actana-setup-e2e-macos`
job walked setup, the loaded LaunchAgent, a core-link dial with the printed
pairing token, every lifecycle verb, and two idempotent re-installs, on both
`mac-arm64` and `mac-x64` runners. [ADR 0016](adr/0016-the-0-1-0-shape.md) D35
deleted it — macOS runners bill at 10×, and those two legs plus the macOS
`panel-e2e` were 72% of the CI bill for a platform
[#6](https://github.com/actana/control/issues/6) descoped.

So this checklist is now the whole macOS install story, not the tail of it.
Two of its sections were always going to be manual whatever CI did — a GitHub
runner is destroyed rather than restarted, and a LaunchAgent is by definition
tied to a login session, so "does the Core come back?" can only be answered by
a person on a real Mac. The rest is here because nothing else checks it any
more.

Run this once per release on **one Apple-silicon Mac** and, when the release
touches the install path, **one Intel Mac**. Ten minutes.

Its Linux counterpart is [the one-liner rehearsal](core-linux-rehearsal.md) —
`pnpm core:rehearse` for a throwaway machine to paste the real one-liner
into. Run both before a release: this one is the only check the macOS install
path gets at all, that one protects the prompts and the pairing token.

---

## Before you start

- A Mac you can reboot and log back into.
- No Actana Core installed yet (`launchctl print gui/$(id -u)/com.actana.core`
  should fail). If one is installed, this is an upgrade rehearsal instead —
  note that in the results.
- The release's `mac-arm64` / `mac-x64` tarball and its `SHA256SUMS`.

---

## 1 — Install, the way an operator does

```bash
shasum -a 256 --ignore-missing -c SHA256SUMS
```

- [ ] Prints `OK`.

```bash
tar -xzf actana-core-<version>-mac-arm64.tar.gz && ./actana-core-<version>-mac-arm64/bin/actana setup
```

- [ ] No password prompt, and nothing asks for an administrator.
- [ ] **No Gatekeeper dialog** — no "cannot be opened because the developer
      cannot be verified", for the launcher or for the bundled `node`. (If one
      appears, that is a release blocker, not something to click through: note
      exactly which binary it named.)
- [ ] Ends by printing a pairing token.

```bash
actana status
```

- [ ] `Core: healthy`, the LaunchAgent named as `com.actana.core`, and an
      `At login` row.

---

## 2 — The Core is actually usable

- [ ] Paste the pairing token into a Panel's **Add Core**. The Core appears and
      its projects list loads.

---

## 3 — Reboot persistence — the part CI cannot do

```bash
sudo shutdown -r now
```

Log back in as the same user. **Wait 30 seconds** (launchd starts harnesses a
little after the desktop appears), then:

```bash
actana status
```

- [ ] `Core: healthy` again, with a **different** PID from before the reboot.
- [ ] `actana token` prints a token whose Core is the one already paired — the
      Panel reconnects without being re-paired.
- [ ] The Panel shows the Core online again without any action taken on it.

---

## 4 — Logout behaviour is what we tell operators it is

The `At login` row in `actana status` claims the daemon starts at login and
stops at logout. Verify that claim rather than trusting it:

- [ ] Log out (**not** lock the screen — the Apple menu's *Log Out*).
- [ ] Log back in, wait 30 seconds, `actana status` → healthy again.

If you have a second admin account and want the stronger check: log in as the
other user while the Core's user is logged out, and confirm from there that
`nc -z <ip> 8443` fails — that is the documented limitation of a sudo-less
LaunchAgent, and it should behave as documented rather than surprisingly.

---

## 5 — Leave the machine as you found it

```bash
actana uninstall --purge-data
```

- [ ] `launchctl print gui/$(id -u)/com.actana.core` reports no such service.
- [ ] `~/Library/LaunchAgents/com.actana.core.plist`, `~/.local/bin/actana`,
      `~/.local/share/actana` and `~/.config/actana` are all gone.

The macOS log directory is the one thing `--purge-data` leaves — remove it by
hand if you want the machine spotless:

```bash
rm -rf ~/Library/Logs/Actana
```

---

## Recording the result

Note in the release PR: macOS version, chip (M-series or Intel), and which
boxes did not tick. An unticked box in section 3 or 4 is a release blocker —
those are the two properties this checklist exists to protect.
