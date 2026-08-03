# 07 — Container test matrix, Core-in-a-box, human rehearsal

**What to build:** The testing ecosystem around the installer. (1) A CI matrix of systemd-enabled containers (Ubuntu + Debian; linux-x64 and linux-arm64 on arm runners) running the full one-liner e2e — install, verbs, update, regenerate, uninstall — against the fixture server on every relevant change. (2) The same image family published/reusable as the "Core-in-a-box" fixture, so the Panel epic's e2e can pair against a containerized Core. (3) A one-command human rehearsal: spin up the fake-remote-VM container, paste the real one-liner interactively, take the pairing token to a live Panel — documented as a routine pre-release step.

**Blocked by:** 03 — `install.sh` one-liner + hermetic release fixture.

**Status:** done

- [x] CI matrix runs the complete installer e2e across distros and both Linux architectures; failures block merge
- [x] Core-in-a-box image boots a paired-ready Harness consumable as a fixture by the Panel e2e smoke
- [x] One documented command starts the interactive rehearsal container; the manual flow is written down step-by-step
- [x] Matrix runtime stays reasonable (parallel jobs, cached artifacts)
- [x] The rehearsal doc lives beside the pre-release checklist from the macOS ticket
