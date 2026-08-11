<!--
  ⚠️ PR titles MUST follow Conventional Commits — CI enforces this, on the
  title AND on every commit in the branch.
  Format:  <type>(<scope>): <subject>     e.g.  feat(auth): add OAuth2 device flow
  Types: feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert
  We squash-merge: your PR title becomes the commit message. Write it carefully.
-->

> ### 🚂 Is this based on the open train?
>
> **Work reaches `main` only by promoting a whole train, so this PR should
> target the open `beta/x.y.z` branch — not `main`.** GitHub bases new pull
> requests on the default branch, which is `main`, so the first one you open
> targets the wrong thing. Use **Edit** beside the title to change the base;
> you do not need to close it or re-push.
>
> `git ls-remote --heads origin 'refs/heads/beta/*'` names the open train.
> The `Train rules` check enforces this — see
> [CONTRIBUTING.md](../CONTRIBUTING.md#where-your-pr-goes-the-open-train-not-main).
>
> *Delete this block once you have retargeted.*

> ### 🚦 Promoting a train? Do not press Merge.
>
> A promotion PR (`beta/x.y.z` → `main`) is a **gate, not a merge**. A squash
> here would produce a `main` commit whose SHA differs from the tested one, and
> the digest assertion cannot survive that. GitHub closes this PR as merged on
> its own once the fast-forward lands.
>
> 1. Freeze the train.
> 2. Work [`docs/beta-acceptance-checklist.md`](../docs/beta-acceptance-checklist.md)
>    against `beta-x.y.z`, and the
>    [macOS pre-release checklist](../docs/core-macos-prerelease-checklist.md)
>    against the train tip.
> 3. `gh workflow run promote.yml -f train=beta/x.y.z`, then approve the run.
>
> *Delete this block on an ordinary PR.*

## Summary

<!-- What does this PR do, and why? 2–5 sentences. Link the design doc/RFC if one exists. -->

## Related issues

<!-- Every PR must be linked to at least one issue. Use closing keywords. -->

Closes #

## Type of change

<!-- Check exactly the ones that apply. -->

- [ ] 🐛 Bug fix (non-breaking change fixing an issue)
- [ ] ✨ New feature (non-breaking change adding functionality)
- [ ] 💥 Breaking change (fix or feature causing existing behavior to change)
- [ ] ♻️ Refactor (no functional change)
- [ ] 📚 Documentation
- [ ] 🔧 Build / CI / tooling

## How was this tested?

<!-- Describe the tests you added/ran. "Tested manually" alone is not sufficient for logic changes. -->

- [ ] Unit tests added/updated
- [ ] Integration/E2E tests added/updated
- [ ] Manually verified (describe steps below)

## Breaking changes & migration

<!-- Delete this section if not applicable. Otherwise describe what breaks and how consumers migrate. -->

## Screenshots / recordings

<!-- For UI changes: before/after. Delete if not applicable. -->

## Checklist

- [ ] This PR targets the **open train** (`beta/x.y.z`), not `main`
- [ ] My PR title **and every commit in the branch** follow [Conventional Commits](https://www.conventionalcommits.org/), and my branch name follows the [branching convention](../CONTRIBUTING.md#branch-naming)
- [ ] I performed a self-review of my own code
- [ ] I commented hard-to-understand areas / added docs where needed
- [ ] I added tests proving my fix/feature works, and all tests pass locally
- [ ] I updated documentation (README, docs/, changelog entry) where relevant
- [ ] No secrets, credentials, or personal data are included in this change
- [ ] Dependent changes have been merged (or this PR is marked as draft/stacked)
