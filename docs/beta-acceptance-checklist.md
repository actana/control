# Beta acceptance checklist

**Work this against `beta-x.y.z` before dispatching the promotion.** The image
you approve here is, byte for byte, the image that ships — promotion re-points
this exact digest at `x.y.z` and `latest` and builds nothing
([`ci-cd.md`](ci-cd.md#the-digest-guarantee-where-it-starts-and-where-it-stops)).
So "it worked when I tested it" is a claim about the released artifact for once,
and that is only true if somebody actually runs it.

Fifteen minutes. Two people can split it; one person can do it all.

> **Freeze the train first.** `beta-x.y.z` moves on every merge into the train,
> so anything merged while you are testing invalidates this run — the promotion
> will refuse with *"the train moved; re-approve"*, which is the design working
> rather than a fault. Announce the freeze, then start.

The macOS pre-release checklist is a **separate** gate worked at the same time,
against the train tip:
[`core-macos-prerelease-checklist.md`](core-macos-prerelease-checklist.md).
Both must pass before you approve.

---

## 1. Pull the beta

```bash
export ACTANA_TAG=beta-0.2.0        # the open train's version
cd deploy
docker compose pull
```

- [ ] Both images pulled, and neither resolved to `latest`
- [ ] `docker compose config | grep image:` shows `beta-0.2.0` on **both**
      services — they are version-locked, and a mismatched pair is not what
      ships

Somewhere disposable, please. A beta is not a thing to point at your real
`panel-data` volume: a schema migration on an unreleased build has made no
promises about what happens next.

## 2. Compose up, first boot

```bash
docker compose up -d
docker compose logs core
docker compose exec core actana pair new     # the code, and the CA fingerprint
```

- [ ] Both containers reach `running` and stay there for a minute
- [ ] `http://localhost:7420` serves the first-boot setup screen
- [ ] Creating the Operator works, and logging out and back in works
- [ ] The Core's log holds no credential — no `BEGIN CERTIFICATE`, no bearer
- [ ] `actana pair new` prints a code, a CA fingerprint and an expiry

## 3. Pair a Core

- [ ] **Add Core** takes the Core's address, shows the fingerprint it was
      presented, and it matches the one `pair new` printed
- [ ] Spending the code registers the Core
- [ ] The same code is refused the second time
- [ ] The Core shows as reachable in Fleet view — **not** "needs update".
      "Needs update" here means the Panel and Core versions disagree, which on
      a beta usually means one image did not move
- [ ] Adding a project under `./repos` finds it
- [ ] Starting a session gives a live terminal, and typing reaches it

That last one is the whole product in one gesture: it exercises the panel link,
the core-link, the PTY and the event log together.

## 4. Survive a restart

```bash
docker compose restart
```

- [ ] The Panel still knows its Operator — no second setup screen
- [ ] The Core is still paired — pairing survives a restart, and only
      destroying the volume unpairs it
- [ ] A session started before the restart replays rather than vanishing

## 5. The CHANGELOG matches

- [ ] [`CHANGELOG.md`](../CHANGELOG.md) has an entry for this version
- [ ] Its entries match what actually merged into the train —
      `git log --oneline origin/main..origin/beta/x.y.z` is the source, since
      every squash commit's subject is a PR title. **The git ref is
      `beta/x.y.z` with a slash**; `beta-x.y.z` is the Docker tag and is not a
      revision this command can resolve
- [ ] Anything user-visible in that log is in the CHANGELOG, and nothing in the
      CHANGELOG is absent from the log
- [ ] Breaking changes are called out as such

## 6. Version surfaces agree

- [ ] Every manifest says `x.y.z` — root, `packages/cli`, `packages/core`,
      `packages/panel`, `packages/sdk`, `packages/shared`. The `Train rules`
      check asserts this, so it should already be green; look if it is not
- [ ] `actana status` inside the Core reports the same version
- [ ] The Panel's UI reports the same version

```bash
docker compose exec core actana status
```

---

## Then

```bash
docker compose down -v            # -v: this was a throwaway
```

- [ ] Every box above is ticked, **or** the promotion does not happen

An unticked box is a reason to hold the train, not a reason to note it in the
promotion pull request and carry on. Fix it, let the train republish, and work
this list again against the new image — the digest assertion means the version
you tested is the only one that can ship, so re-testing is not optional
ceremony.

When it passes, and the macOS checklist passes:

```bash
gh workflow run promote.yml --repo actana/control -f train=beta/0.2.0
```

then approve the run when it asks. Nothing has been published before that
approval — no image has moved, no Release exists, and `main` has not advanced —
so **rejecting is a real answer**, and it is the answer whenever a box above is
unticked. See [`ci-cd.md` § Promotion](ci-cd.md#promotion).
