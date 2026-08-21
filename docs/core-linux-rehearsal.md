# Linux Core — the one-liner rehearsal

CI installs a Core on Linux several times per pull request: `.github/workflows/ci.yml`'s
`installer-e2e` job runs `scripts/e2e-actana-setup-linux.mjs` — the real
one-liner, then the lifecycle verbs on the machine it produced — across Ubuntu
and Debian at x64, and the `core-image` job pairs a Panel with the containerised
Core. arm64 runs the same script on the release tag
(`.github/workflows/release.yml`).

All of it runs with the prompts suppressed and nobody watching. That is the
gap this fills: **once per release, a person pastes the real one-liner into a
machine that has never seen it, answers the questions it asks, and takes a
pairing code to a live Panel.** What it catches is the class of problem a green
matrix cannot — a prompt that reads badly, a code that is awkward to read out
loud, an instruction that is technically true and practically useless.

Fifteen minutes, and the only install rehearsal a release needs — Linux is the
only platform a release publishes a Core for. [The macOS
checklist](core-macos-prerelease-checklist.md) covers the same ground for a
Mac Core built from source, and gates nothing.

---

## Before you start

- Docker, able to run a privileged container (Docker Desktop is fine).
- Nothing else listening on port **8443** — see [Ports](#ports) if there is.
- A **Linux** tarball matching your Docker daemon's architecture.

On a Linux host that is just:

```bash
pnpm core:tarball
```

On **macOS**, `pnpm core:tarball` builds a `mac-*` tarball — the bundled
native modules are compiled for the host, so there is no cross-build. Build the
Linux one in a container instead (a few minutes, mostly `pnpm install`):

```bash
docker run --rm -v "$PWD":/repo -w /repo node:24 bash -c 'apt-get update -qq && apt-get install -y -qq python3 make g++ && corepack enable && corepack pnpm@11.1.2 install && corepack pnpm@11.1.2 core:tarball'
```

That writes into `artifacts/core/` like the native build does, and
`core:rehearse` picks up the newest tarball for your architecture on its own.

> Mounting the repo lets the container rewrite `node_modules` with Linux
> binaries. Run `pnpm install` afterwards to put your host's back, or copy the
> repo elsewhere first if that would disrupt you.

---

## 1 — Bring up a machine that has never seen the installer

```bash
pnpm core:rehearse
```

That one command builds a systemd container with **no sudo on it**, starts a
local release channel serving the tarball you just built, prints the one-liner
to paste, and drops you into a shell inside the machine as `operator`.

- [ ] The banner prints a `curl -fsSL … | bash -s -- --base-url …` command.
- [ ] The prompt that follows is inside the machine (`whoami` says `operator`,
      `sudo` is not found).

To rehearse on Debian instead of Ubuntu, or on another port:

```bash
pnpm core:rehearse -- --distro debian --port 9443
```

Add `--keep` if you want the machine to outlive the shell — useful when you are
chasing something and expect to go in and out. The banner then prints how to
re-enter it and how to destroy it.

---

## 2 — Install, the way an operator does

Paste the printed one-liner. **Do not add `--yes`** — the prompts are the point.

- [ ] It asks about enabling lingering, and explains *why* before asking.
- [ ] It offers to install the harness CLIs it found missing, one at a time.
      (Decline them all — this machine has no vendor logins on it, and CI
      already covers accepting.)
- [ ] Nothing asks for a password, and nothing mentions `sudo` or `root`.
- [ ] It ends by telling you to run `actana pair new` to enroll a client.
- [ ] **It prints no credential.** No `BEGIN CERTIFICATE`, no `BEGIN PRIVATE
      KEY`, no base64 block to copy — the hand-carry is gone (#287) and its
      reappearance is a release blocker.

```bash
actana status
actana pair new --label my-panel
```

- [ ] `Core: healthy`, the version you just built, and a `Linger` row.
- [ ] `actana` is on `PATH` in this shell without sourcing anything by hand.
- [ ] `pair new` prints a **pairing code** as `XXXX-XXXX`, the Core's **CA
      fingerprint**, and when the code expires.
- [ ] The code is short enough to read out loud over a phone without spelling
      anything — no `0`, `O`, `1`, `I` or `L` in it.

---

## 3 — Take the code to a live Panel

In another terminal on your own machine, start a Panel:

```bash
pnpm dev:server
```

Open http://localhost:5173, create the Operator if it is a fresh data
directory, then **Add Core**, give it `127.0.0.1:8443` and the code from step 2.

- [ ] The Panel shows the fingerprint it was presented **before** asking for the
      code, and it matches what `pair new` printed.
- [ ] The Core appears and reaches **connected**.
- [ ] Entering the same code again is refused — it is spent.
- [ ] Its projects list loads (empty is correct — the machine has no projects).
- [ ] The Panel shows no "needs update" state; the Core is the version the
      Panel expects.

---

## 4 — Work the Core like an operator

Back in the container shell:

```bash
mkdir -p ~/demo && git -C ~/demo init -q
```

- [ ] Add `~/demo` as a project from the Panel; it appears in the list.
- [ ] Open a terminal on the Core from the Panel. It lands in a login shell,
      `pwd` is what you expect, and typing echoes back without lag.

**Stay in this shell.** Typing `exit` ends the rehearsal and destroys the
machine — that is section 6. (That the daemon survives your session ending is
lingering, and CI already asserts it: the setup e2e checks `Linger=yes` and
that the Core comes back after a full reboot.)

---

## 5 — The chores an operator will actually do

```bash
actana restart && actana status
actana logs -n 20
actana pair ls
```

- [ ] The Core reconnects in the Panel on its own after the restart.
- [ ] `actana logs` shows something a person could triage from.
- [ ] `actana pair ls` lists the Panel you paired in step 3, and prints **no
      code** — there is none stored to print.
- [ ] `actana token` on its own refuses and names `actana pair new`.

```bash
actana token regenerate
```

- [ ] It says plainly that this locks out paired clients before doing it.
- [ ] It prints no credential — only what to do next.
- [ ] The Panel's Core goes unauthorized, and a fresh `actana pair new` plus a
      second **Add Core** recovers it.

---

## 6 — Leave nothing behind

```bash
actana uninstall --purge-data
exit
```

- [ ] `uninstall` says what it is about to remove before removing it.
- [ ] After `exit`, the script reports the machine was destroyed.
- [ ] `docker ps -a | grep actana-rehearsal` is empty.

---

## Ports

The Core inside the machine mints its certificate for `127.0.0.1:8443`. The
rehearsal publishes the container on host port **8443** by default precisely so
the address you type into **Add Core** is the one the certificate names.

If 8443 is taken, `--port <n>` moves it — and then you pair against
`127.0.0.1:<n>` instead. The script warns when you are in that case. Freeing
8443 is less error-prone.

---

## Recording the result

Note in the release PR: the distro you used, and which boxes did not tick.

Unticked boxes in sections 2 and 3 are release blockers — "the one-liner ends
with a Core a person can actually pair to a Panel" is the whole product promise
this rehearsal exists to protect. Everything else is a bug report.
