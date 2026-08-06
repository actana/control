# macOS Core — the release approval checklist

> **This page is the gate.** `release.yml`'s `tarball-macos` job declares
> `environment: macos-release`, and that environment has required reviewers, so
> a tag push pauses there until a person approves it (ADR 0016 D28, as
> amended). Working through this list on real Apple hardware **is** what the
> reviewer is approving; `github-release` needs that job, so nothing publishes
> until they do. An unticked box below is a reason to reject the release, not a
> note to file.

**Nothing automated can cover what follows**, which is why the gate is a person
rather than a job. A GitHub runner is destroyed rather than restarted, and a
LaunchAgent is by definition tied to a login session, so "does the Core come
back after a reboot?" and "does it come back after a logout?" can only be
answered on a real Mac. Gatekeeper is the same kind of question: the tarball
ships unsigned and un-notarized (out of scope — see
[#55](https://github.com/actana/control/issues/55)), and whether macOS lets an
operator run it is not something a headless runner experiences.

The `tarball-macos` leg does the part a runner *can* do: it builds the
`mac-arm64` tarball on an Apple-silicon runner and boots it through its own
launcher with no system Node. There has been no macOS setup e2e since
[ADR 0016](adr/0016-the-0-1-0-shape.md) D35 deleted it — macOS runners bill at
10×, and those legs plus the macOS `panel-e2e` were 72% of the CI bill — and
that stays deleted. **Zero macOS in per-PR CI**; one leg, on a release, behind
this list.

Run this on **one Apple-silicon Mac**. Ten minutes. There is nothing to run on
an Intel Mac: there is no `mac-x64` asset and there will not be one — an Intel
Mac runs its Core from the container image, and both `install.sh` and
`actana update` refuse it at detection and say so.

The Linux path is covered by
[the one-liner rehearsal](core-linux-rehearsal.md): `pnpm core:rehearse` for a
throwaway machine to paste the real one-liner into. Same standing as this page
now has, for the other half of the release.

---

## Before you start

- A Mac you can reboot and log back into, on Apple silicon.
- No Actana Core installed yet (`launchctl print gui/$(id -u)/com.actana.core`
  should fail). If one is installed, this is an upgrade rehearsal instead —
  note that in the results.
- A `mac-arm64` tarball **built from the tagged commit**. The waiting leg has
  not run, so there is nothing to download yet: check the tag out on the Mac
  and run `pnpm core:tarball`, which builds the host's own target and produces
  the same asset the leg will.

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

## Recording the result, and approving

Post it as a comment on the release's own tracking issue, or on the run:
macOS version, chip, and which boxes did not tick.

Then approve or reject the waiting `tarball-macos` job. Sections 3 and 4 are
the two properties this checklist exists to protect, and an unticked box in
either means the Mac Core in front of you is not fit to run — as does the
Gatekeeper box in section 1. Any of those three is a **reject**: the release
publishes no assets at all rather than a macOS tarball nobody could get
working, and the fix ships in the next tag.

Approving spends the runner minutes, attaches the four assets, and publishes
the release. Nothing else is waiting on you afterwards.
