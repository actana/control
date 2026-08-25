# Harness skills

### Issue tracker

Issues and specs live as GitHub issues on `actana/control`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles as label strings: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Upstream harvesting

This repo forked `AgentSystemLabs/mission-control` at `v0.49.0` — a read-only scouting target, never a merge parent. See `docs/agents/upstream-harvest.md`.

### Release trains

Work targets the open `beta/x.y.z` train, never `main`. **A train is cut by a person, by hand, and never by a workflow** — nothing guesses a version (ADR 0023 D3, D22 and D25, as amended by #325), and the cut writes the version into all six manifests in its first commit. The procedure is [`docs/ci-cd.md` §Cutting a train](docs/ci-cd.md#cutting-a-train); when no train is open, `promote.yml` and `housekeeping.yml` open the tracking issue that says so. **Promotion consumes an existing, approved pull request from the train into `main`** — open it, let its checks settle, get it approved, then dispatch `promote.yml`. `Promotion gate` is red on that pull request by design and stays red: red is the healthy state there, not a problem to fix (#264). That pull request is a gate, not a merge: do not press the merge button. See [`CONTRIBUTING.md` §Where your PR goes](CONTRIBUTING.md#where-your-pr-goes-the-open-train-not-main), [`docs/ci-cd.md` §The train model](docs/ci-cd.md#the-train-model) and [§Cutting a release](docs/ci-cd.md#cutting-a-release), and [ADR 0023](docs/adr/0023-release-trains-and-digest-promotion.md).
