# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub:
[**Security → Report a vulnerability**](https://github.com/actana/control/security/advisories/new).
This opens a private advisory visible only to you and the maintainers.

Please include: what you found, the version or commit, how to reproduce it, and
what an attacker gets out of it. A proof of concept helps but is not required
to file.

We aim to acknowledge a report within **3 working days** and to have an
assessment back to you within **10**. Fixes ship in a normal release; the
advisory is published once a fixed version is available, crediting you unless
you would rather stay anonymous.

## Supported versions

Only the **latest release** is supported. There are no backport branches — if
you are on an older tag, the fix is to upgrade. The Panel upgrades by pulling a
new image; a Core upgrades with `actana update` on its machine.

A **beta** is not a release. The open train is installable — as the
`beta-x.y.z` and `x.y.z-beta` images, and on metal from the train's own ref
([ADR 0036](docs/adr/0036-the-beta-release-channel.md)) — and none of it is a
supported version. Report what you find on one anyway: it is the cheapest place
to fix a problem, and a beta report is a report against the next release. The
answer to *"which version is fixed"* will be a release, and a machine on a beta
gets there by moving to that release.

## What is in scope

The things this project actually controls:

- The **Panel** — the web service, its session/cookie handling, the Operator
  password path, its HTTP API and bearer-token surface.
- The **core-link** — the mutual-TLS WebSocket between a Panel and a Core, the
  short-code pairing that issues a client its certificate, and the credential
  that establishes the link.
- The **Core** — the daemon, `actana setup`, the installer (`install.sh`),
  and the published tarballs and their checksums. `install.sh` installs and
  stops; `actana setup` is the separate command that activates a machine, and
  both are in scope. The tarballs of a beta prerelease are the same artifact,
  built by the same scripts and verified against the same `SHA256SUMS`, and are
  in scope on the same terms.
- The **published container image**, [`actana/panel`](https://hub.docker.com/r/actana/panel) on Docker Hub.

## What is out of scope

- **Anything reachable only by the Operator on their own machines.** A Core
  runs harness CLIs with the operator's own privileges and gives them a shell on
  that machine — a VM Shell Session executing commands is the product working,
  not a sandbox escape. There is no privilege boundary between the Operator and
  the machines they have registered.
- **A Panel deliberately exposed over plain HTTP.** The Panel emits plain HTTP
  and delegates TLS to a reverse proxy ([ADR 0010](docs/adr/0010-panel-becomes-a-self-hosted-web-service.md)).
  Running it on a public interface without a proxy is a deployment mistake, and
  [`DEPLOY.md`](DEPLOY.md) says so.
- **The harness CLIs themselves** (claude, opencode, codex, …). Report those to
  their own vendors.
- Findings from automated scanners with no demonstrated impact, and
  vulnerabilities in dependencies that are already flagged by Dependabot and
  the `dependency-audit` CI job.

## Hardening notes for operators

- Put the Panel behind a TLS-terminating proxy that forwards
  `X-Forwarded-Proto: https` — without it the session cookie is not marked
  `Secure`. The reference [`deploy/docker-compose.yml`](deploy/docker-compose.yml)
  does this for you.
- Set `AC_SECRETS_KEY` rather than letting the key be generated inside the data
  directory. Otherwise a copied volume or a backup archive carries both the
  sealed Core credentials and the key that opens them.
- The data directory is the entire Panel: Operator, sessions, Core registry,
  and sealed credentials. Treat backups of it as secret material.
