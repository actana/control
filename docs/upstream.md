# Upstream provenance

Actana Control began as a fork of
[AgentSystemLabs/mission-control](https://github.com/AgentSystemLabs/mission-control)
at tag `v0.49.0` (`8dff848`). It is no longer a fork in any working sense.

**What is ours.** The Core is an original process — the daemon, its SQLite
database, the PTY and Harness layer, the CLI, and both links (the mutual-TLS
core-link and the browser's panel-link) were written for this project, not
inherited ([ADR 0001](adr/0001-detach-core-from-panel.md),
[0002](adr/0002-core-link-auth-and-transport.md),
[0004](adr/0004-core-owns-write-path.md),
[0013](adr/0013-core-is-the-machine-harness-is-the-cli.md)). So are the release
pipeline, the installer, the deployment surfaces, and everything the Panel does
across more than one machine. The scope-narrowing that removed the upstream
feature areas is recorded in the ADRs.

**What is inherited.** Parts of the Panel's web UI remain derived from
upstream's React components, carried forward and reworked rather than rewritten
from nothing.

**Upstream is not tracked.** It is not a merge parent, not a remote, and not
scouted on a cadence — the two codebases have diverged past the point where a
patch from there applies here. Nothing in this repository needs to stay in step
with it.

**Licensing.** Upstream is MIT and this project is MIT. [`../NOTICE`](../NOTICE)
is the attribution of record: it names the fork point and states that files
still derived from upstream keep their original MIT license and copyright.
