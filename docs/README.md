# Documentation

Start with the task you actually have.

## I want to run this

| Goal | Read |
| --- | --- |
| Understand what this is before installing anything | [`../README.md`](../README.md) |
| Deploy the **Panel** — the web service you drive everything from | [`../DEPLOY.md`](../DEPLOY.md) |
| Turn a machine into a **Core** — install the Core bundle on it | [`../INSTALL.md`](../INSTALL.md) |
| Get a Panel + Core pair running locally without provisioning anything | [`../deploy/docker-compose.yml`](../deploy/docker-compose.yml) |
| Configure it — every environment variable | [`../DEPLOY.md#configuration`](../DEPLOY.md#configuration) |
| Back it up, upgrade it, or restore it | [`../DEPLOY.md#backup`](../DEPLOY.md#backup) |
| Fix an install that went wrong | [`../INSTALL.md#troubleshooting`](../INSTALL.md#troubleshooting) |
| Drive it from another tool over HTTP | [`../README.md#external-api`](../README.md#external-api) |

The order that works: **deploy a Panel first**, then install a Core on each
machine, then paste that machine's pairing token into the Panel.

## I want to contribute

| Goal | Read |
| --- | --- |
| Set up, run the tests, and get a PR merged | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Learn the vocabulary reviewers use | [`../CONTEXT.md`](../CONTEXT.md) |
| Understand why the architecture is the way it is | [`adr/`](adr/) |
| Know what CI will run and what it publishes | [`ci-cd.md`](ci-cd.md) |
| Report a security problem | [`../SECURITY.md`](../SECURITY.md) |
| Ask a question or get help | [`../SUPPORT.md`](../SUPPORT.md) |
| Know who decides what | [`../GOVERNANCE.md`](../GOVERNANCE.md) |

**Read [`../CONTEXT.md`](../CONTEXT.md) before writing code.** It is the
project's glossary — Panel, Core, Harness, core-link, Task, Session — and it
carries the invariants a reviewer will hold you to.

## I am administering the repository

| Goal | Read |
| --- | --- |
| Set up the GitHub repo: secrets, rulesets, labels, teams | [`REPO_SETUP.md`](REPO_SETUP.md) |
| Add Docker Hub publishing keys | [`REPO_SETUP.md#2-secrets-and-variables`](REPO_SETUP.md#2-secrets-and-variables) |
| Cut a release | [`ci-cd.md#cutting-a-release`](ci-cd.md#cutting-a-release) |
| Know why this repo has no tag before `v0.1.0` | [`REPO_SETUP.md#6-tag-history`](REPO_SETUP.md#6-tag-history) |

## Architecture decisions

[`adr/`](adr/) — numbered, immutable-once-landed records of why the system is
shaped the way it is. If a change contradicts one, say so in the PR rather than
routing around it.

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-detach-core-from-panel.md) | Detach the Core from the Panel |
| [0002](adr/0002-core-link-auth-and-transport.md) | Core-link auth and transport |
| [0003](adr/0003-core-install-and-registration.md) | Core install and registration |
| [0004](adr/0004-core-owns-write-path.md) | The Core owns the write path |
| [0005](adr/0005-singular-ui-across-cores.md) | Singular UI across Cores |
| [0006](adr/0006-no-bundled-skills.md) | No bundled skills |
| [0007](adr/0007-scope-narrowing-and-rebrand.md) | Scope narrowing and rebrand |
| [0008](adr/0008-cross-core-session-finish-notifications.md) | Cross-core session-finish notifications |
| [0009](adr/0009-remove-managed-sandbox.md) | Remove the managed sandbox |
| [0010](adr/0010-panel-becomes-a-self-hosted-web-service.md) | The Panel becomes a self-hosted web service |
| [0011](adr/0011-operator-identity-and-panel-auth.md) | Operator identity and Panel auth |
| [0012](adr/0012-panel-link-browser-transport.md) | Panel link browser transport |
| [0013](adr/0013-core-is-the-machine-harness-is-the-cli.md) | Core is the machine, Harness is the CLI |
| [0016](adr/0016-the-0-1-0-shape.md) | The 0.1.0 shape: two images, one installer, three workflows |

## Reference

- [`domain-model.md`](domain-model.md) — product names, identifiers, and env-var prefixes
- [`provider-usage.md`](provider-usage.md) — the multi-provider usage aggregator
- [`harness-status-detection.md`](harness-status-detection.md) — how a Task's status is inferred
- [`skills/`](skills/) — skill files for external CLIs

## Release and platform checklists

- [`core-linux-rehearsal.md`](core-linux-rehearsal.md) — rehearsing a Linux install
- [`core-macos-prerelease-checklist.md`](core-macos-prerelease-checklist.md) — the macOS
  checks a CI runner cannot perform (reboot persistence, chiefly)
- [`local-build-screen-recording.md`](local-build-screen-recording.md)

## Historical record

These describe work that has already shipped. They are kept because they
explain *why* the code looks the way it does — they are not a backlog, and new
work does not go here (it goes in
[GitHub Issues](https://github.com/actana/control/issues); see
[`agents/issue-tracker.md`](agents/issue-tracker.md)).

- [`specs/`](specs/) — the specs for the fork's twelve scope-narrowing efforts
- [`tickets/`](tickets/) — their ticket breakdowns
- [`upstream/`](upstream/) — provenance and divergence from
  `AgentSystemLabs/mission-control`, the project this was forked from at
  `v0.49.0`. See also [`../NOTICE`](../NOTICE)
- [`refactor-plan.md`](refactor-plan.md),
  [`session-orchestrator-brief.md`](session-orchestrator-brief.md)

## For harnesses

[`agents/`](agents/) — configuration the engineering skills read:
[`issue-tracker.md`](agents/issue-tracker.md) (where issues live),
[`triage-labels.md`](agents/triage-labels.md) (the five triage roles),
[`domain.md`](agents/domain.md) (how to consume `CONTEXT.md` and the ADRs), and
[`upstream-harvest.md`](agents/upstream-harvest.md) (how to scout upstream
without merging from it). The entry point is [`../AGENTS.md`](../AGENTS.md).
