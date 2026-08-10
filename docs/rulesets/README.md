# Ruleset payloads

The branch and tag protection for `actana/control`, as the exact JSON the
GitHub API takes. A ruleset clicked together in a form is a configuration
nobody can review and nobody can restore; these files are the reviewable,
restorable form of the same thing.

| File | Target | Applied as |
| --- | --- | --- |
| [`main.json`](main.json) | `main` (`~DEFAULT_BRANCH`) | `PUT` over existing ruleset **20390421** |
| [`beta.json`](beta.json) | `refs/heads/beta/**` | `POST` — new ruleset |
| [`release.json`](release.json) | `refs/heads/release/**` | `POST` — new ruleset |
| [`release-retired.json`](release-retired.json) | one retired line, named explicitly | `POST` — template, one per retirement |
| [`tag-release-cut.json`](tag-release-cut.json) | `refs/tags/v*` | `PUT` over existing ruleset **20390424** |
| [`tag-immutable.json`](tag-immutable.json) | `refs/tags/v*` | not applied — the capture of live ruleset **20390423** |

`tag-immutable.json` is here for restorability rather than for the cutover.
Ruleset 20390423 ("Release tags are immutable") is unchanged by this effort and
nothing in §3 applies it; without it committed, a clone could restore four of
the five live rulesets and the fifth would exist only in the web form. It is a
verbatim capture of what is live — `GET /repos/actana/control/rulesets/20390423`
reduced to the fields the create/update API takes. Applying it would be a
`POST` if 20390423 has been lost and a `PUT` over 20390423 if it has been
edited; either is a deliberate restore, not a step in the cutover.

**Nothing here is applied by CI, and nothing here should be applied from a
branch.** These files are data. Applying them is an admin step, taken
deliberately, in the order and against the preconditions written down in
[`../REPO_SETUP.md`](../REPO_SETUP.md) §3 — read that first. Applying
`main.json` before the `Train rules` check has been watched running green
leaves every pull request permanently Pending, including the one that would
undo it.

## The `actor_id: 0` placeholder

Three payloads name the GitHub App as a bypass actor and carry `"actor_id": 0`.
Zero is not a real App id — it is a deliberate tripwire, so that a payload
applied without substitution fails at the API rather than quietly installing a
ruleset with no working bypass. The real value is the `APP_ID` secret's value
(see [`../REPO_SETUP.md`](../REPO_SETUP.md) §2). §3 has the `jq` line that
substitutes it.

## Keeping these honest

The `required_status_checks` contexts are check-run names, character for
character, as GitHub reports them — not job ids and not the prose names used in
tickets. Two of them are nested (`Panel image / Build + smoke (amd64)`) because
`Panel image` is a call into the reusable `container-image.yml`, and the check
GitHub records is `<caller job name> / <called job name>`. Renaming a job in
`.github/workflows/ci.yml` renames its check, and a required check whose name
no longer exists is Pending forever. Change the workflow and these files in the
same pull request.
