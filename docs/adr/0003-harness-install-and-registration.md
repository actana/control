# Harness install, registration, and auto-start

A Harness is installed by running a single distributable binary's install command on the target machine (Linux or macOS VM, including a Mac Mini used for game-dev work). The install generates the mTLS material (self-signed CA + Harness server cert + Panel client cert) and a signed bearer, emits a single base64 registration blob, and writes a systemd unit (Linux) or launchd plist (macOS) so the Harness daemon auto-starts on boot. The Panel registers a Core by pasting the blob once into "Add Core"; the blob is split into keychain (secrets) and registry (endpoint, label).

## Context

The detached design (ADR 0001) requires a repeatable way to place a Harness on a remote machine and let the Panel dial it. The core-link auth (ADR 0002) mandates mTLS, so the install must provision certs and hand the Panel its client material. The Panel owns only the Core registry, so registration must be a single self-contained artifact, not a cloud discovery step.

## Decision

- **Distributable:** a single binary per platform (Linux amd64/arm64, macOS arm64/x86_64). No Docker, no container requirement — some target machines (e.g. a Mac Mini doing Roblox/Unity dev) don't run Docker and shouldn't need to.
- **Install flow:** `harness install` (or `curl …/install | bash`) on the VM generates the self-signed CA + certs + signed bearer, starts the daemon on a configured port, and prints a single base64 registration blob `{endpoint, caCert, clientCert, clientKey, bearer}`.
- **Panel registration:** "Add Core" accepts one paste of the blob. The Panel parses it, stores secrets in `safeStorage` (macOS keychain / OS equivalent) and `{endpoint, label}` in the Core registry, dials `wss://`, and the Core appears.
- **Auto-start:** the install detects the init system and writes a service unit — systemd on Linux, launchd on macOS — so the Harness daemon survives reboots and comes back automatically. This is required by the stateful-harness decision (ADR 0001): the unattended-operation property means a rebooted VM must resume running agents, not sit silent until an operator SSHs in.
- **Reissue:** if the Panel's keychain copy is lost, re-running `harness install` on the VM reissues the registration blob (existing tasks/SQLite are preserved).

## Considered Options

- **Docker-only Harness + cloud discovery (rejected).** A container image plus a coordination SaaS that lists your Cores. Introduces a cloud dependency the detached design exists to avoid, and forces Docker on targets (e.g. a Mac Mini) that don't run it.
- **Manual binary + manual cert copy (rejected).** Maximum control, but the install friction kills adoption and offers no benefit over the one-paste blob.

## Consequences

- Build pipeline produces per-platform binaries; the install script is the single onboarding surface.
- Auto-start units are small per-OS concerns (~20 lines each) but are what make the unattended property real — without them a rebooted VM is indistinguishable from a downed VM in the Fleet view.
- The Panel's Core registry rows carry `{endpoint, label}` with secrets delegated to `safeStorage`; reissuing is a VM-side operation, not a Panel-side one.
