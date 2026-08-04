# macOS Core — manual checklist

> **No longer a gate on a release.** `mac-arm64` and `mac-x64` were dropped as
> release targets (ADR 0016 D28): a tag publishes two Linux tarballs and their
> `SHA256SUMS`, CI no longer runs a macOS install e2e, and there is no macOS
> tarball to download — so nothing on this page can hold up a release that
> contains no macOS asset. It stays for the people running a Core on a Mac from
> a local build, and because [#55](https://github.com/actana/control/issues/55)
> has not yet promoted its one load-bearing fact — the Gatekeeper blocker in
> section 1, which is a blocker on *any* Mac Core, released or not — into
> `docs/ci-cd.md`. This page goes when that lands.

`scripts/e2e-actana-setup-macos.mjs` (`pnpm core:setup:e2e:macos`) is still in
the tree and still walks setup, the loaded LaunchAgent, a core-link dial with
the printed pairing token, every lifecycle verb, and two idempotent
re-installs — but you now run it by hand, against a tarball you built yourself.

What it **cannot** cover is anything that needs a machine to be rebooted and
logged back into: a LaunchAgent is by definition tied to a login session, so
"does the Core come back?" has to be answered by a person, on a real Mac.

Run this on **one Apple-silicon Mac** and, when the install path changed,
**one Intel Mac**. Ten minutes.

The Linux path — the one that actually ships — is covered by
[the one-liner rehearsal](core-linux-rehearsal.md): `pnpm core:rehearse` for a
throwaway machine to paste the real one-liner into. That one is a release gate;
this one is not.

---

## Before you start

- A Mac you can reboot and log back into.
- No Actana Core installed yet (`launchctl print gui/$(id -u)/com.actana.core`
  should fail). If one is installed, this is an upgrade rehearsal instead —
  note that in the results.
- A `mac-arm64` / `mac-x64` tarball. No release carries one, so build it on the
  Mac itself with `pnpm core:tarball` — from a checkout that has put a `darwin`
  row back into `CORE_TARGETS` (`scripts/lib/core-tarball.mjs`), since the
  shipped one has none.

---

## 1 — Install, the way an operator would

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

## 3 — Reboot persistence — the part a runner cannot do

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

Note wherever the work is being tracked: macOS version, chip (M-series or
Intel), and which boxes did not tick. Sections 3 and 4 are the two properties
this checklist exists to protect, and an unticked box in either means the Mac
Core in front of you is not fit to run — as does the Gatekeeper box in section
1. What has changed is only who that blocks: a release ships no macOS asset, so
it is the operator of that machine, not a release, that this stops.
