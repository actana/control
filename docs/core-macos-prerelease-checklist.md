# macOS Core — the release approval checklist

> **This page is the gate.** The `macos-release` environment has required
> reviewers, and the job that declares it pauses until a person approves.
> Working through this list on real Apple hardware **is** what the reviewer is
> approving. An unticked box below is a reason to reject the release, not a
> note to file.
>
> **Where the pause sits is moving** ([ADR
> 0023](adr/0023-release-trains-and-digest-promotion.md) D15). It used to be
> `release.yml`'s `tarball-macos` job, which paused after the tag was pushed;
> it becomes the **first** step of `promote.yml`, so the fast-forward onto
> `main` is downstream of the approval too and `main` never contains
> unapproved code. Exactly one pause exists either way, and this checklist is
> unchanged by the move. `release.yml` no longer carries the environment
> (#110); `promote.yml` picks it up (#111).
>
> One practical difference for you: you build the tarball you are testing from
> the **train tip** rather than from a tag that does not exist yet. By D16's
> assertion that is the same commit, and it is available earlier.

**Nothing automated can cover what follows**, which is why the gate is a person
rather than a job. A GitHub runner is destroyed rather than restarted, and a
LaunchAgent is by definition tied to a login session, so "does the Core come
back after a reboot?" and "does it come back after a logout?" can only be
answered on a real Mac. Gatekeeper is the same kind of question: the tarball
ships unsigned and un-notarized, deliberately and for a reason that is written
down — see [Integrity is published checksums, not
signatures](ci-cd.md#integrity-is-published-checksums-not-signatures) — and
whether macOS lets an operator run it is not something a headless runner
experiences.

The `tarball-macos` leg does the part a runner *can* do: it builds the
`mac-arm64` tarball on an Apple-silicon runner and boots it through its own
launcher with no system Node. There has been no macOS setup e2e since
[ADR 0016](adr/0016-the-0-1-0-shape.md) D35 deleted it — macOS runners bill at
10×, and those legs plus the macOS `panel-e2e` were 72% of the CI bill — and
that stays deleted. **Zero macOS in per-PR CI** still holds and is the half of
D35 that mattered.

What changed is how often the one leg runs. A **beta cut** builds and
boot-smokes a `mac-arm64` tarball too, so the leg now runs on a request as well
as on a release ([ADR 0036](adr/0036-the-beta-release-channel.md) D13). That is
real recurring spend against the budget D35 cut, accepted deliberately: a beta
without a macOS tarball is not installable the same way a release is on the one
platform where the Core is an on-device product, and a cut is dispatched by a
person rather than caused by a merge. **There is still no macOS install e2e on
any trigger** — that is what this list is.

Run this on **one Apple-silicon Mac**. Ten minutes. There is nothing to run on
an Intel Mac: there is no `mac-x64` asset and there will not be one — an Intel
Mac runs its Core from the container image, and both `install.sh` and
`actana update` refuse it at detection and say so.

The Linux path is covered by
[the install rehearsal](core-linux-rehearsal.md): `pnpm core:rehearse` for a
throwaway machine to run the real one-liner and the `actana setup` it prints on.
Same standing as this page now has, for the other half of the release.

---

## Before you start

- A Mac you can reboot and log back into, on Apple silicon.
- No Actana Core installed yet (`launchctl print gui/$(id -u)/com.actana.core`
  should fail). If one is installed, this is an upgrade rehearsal instead —
  note that in the results.
- A `mac-arm64` tarball **built from the commit you are approving**. The
  release's own leg is waiting on you, so there is nothing on the release to
  download: check the train tip out on the Mac and run `pnpm core:tarball`,
  which builds the host's own target and produces the same asset the leg will.

  **If this line has been cut as a beta, download that instead.** A beta cut
  publishes a `mac-arm64` tarball at `x.y.z-beta` on its prerelease, built and
  boot-smoked on an Apple-silicon runner, with `SHA256SUMS` beside it. It is the
  same three targets a release builds. Use it only when the cut names the commit
  you are approving — a beta is cut at whatever train tip somebody asked for,
  which is not always the tip being promoted — and verify the checksum before
  extracting, exactly as an operator would.

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
- [ ] Ends by telling you to run `actana pair new`, and prints no credential —
      no `BEGIN CERTIFICATE`, no base64 block to copy.

```bash
actana status
actana pair new --label my-panel
```

- [ ] `Core: healthy`, the LaunchAgent named as `com.actana.core`, and an
      `At login` row.
- [ ] `pair new` prints a pairing code, this Core's CA fingerprint and an expiry.

---

## 2 — The Core is actually usable

- [ ] Give a Panel's **Add Core** this Mac's address and that code. The
      fingerprint the Panel shows matches the one `pair new` printed, the Core
      appears, and its projects list loads.

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
- [ ] `actana pair ls` still lists the Panel from step 2 — the identity survived
      the reboot and nothing has to be paired again.
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
Gatekeeper box in section 1. Any of those three is a **reject**.

**Rejecting stops everything a release would publish**, not just the macOS
tarball: no GitHub Release, no Linux tarballs, no `actana/panel` or
`actana/core` image, no moved `:latest`. With the pause at the head of
promotion (ADR 0023 D15) it also stops the fast-forward itself, so `main` does
not advance either. Nothing needs rolling back, because nothing left the
repository — the fix rides the train and is promoted next time.

Approving spends the runner minutes, then releases the images and the four
assets in one go. Nothing else is waiting on you afterwards.
