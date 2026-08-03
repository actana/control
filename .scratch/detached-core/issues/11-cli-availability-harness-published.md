# 11 — CLI availability: Harness publish + Core-aware `NewAgentDialog`

**What to build:** The Panel stops probing local PATH directly. Instead, every Harness runs its own availability probe (the same code the local Harness runs today via `lib/cli-availability.ts`) and publishes the result — `{agentId → {status: "checking" | "installed" | "missing" | "outdated", version?}}` — as a field on the core-link state snapshot. `useCliAvailability(coreId)` reads from a per-Core store fed by that snapshot; `NewAgentDialog` opens with the availability answer already in hand, disables missing agents, and blocks submit on `missing` — identically for Loopback and every remote Core.

**Blocked by:** 08 — needs `NewAgentDialog` mounted with a `coreId` prop for every Core.

**Status:** ready-for-agent

- [ ] Harness computes CLI availability at startup, on a periodic tick, and on relevant filesystem events (matches the cadence the local probe uses today).
- [ ] Availability map is emitted as a field on the core-link state snapshot the Harness publishes to the Panel; Loopback and remote Cores emit the identical shape.
- [ ] Availability changes append an `agents:availabilityChanged` event to the Harness event log so reconnecting Panels catch up through the standard replay path.
- [ ] `useCliAvailability(coreId)` reads from a per-Core Panel store hydrated by that snapshot; returns the same `{status, version?}` shape the local hook returns today.
- [ ] `NewAgentDialog` uses `useCliAvailability(coreId)` (not the un-parameterised hook); disabled state for missing agents renders per-Core; submit is blocked when the picked agent's status on the picked Core is `missing`.
- [ ] Loopback flow: the local IPC availability polling is retired; Loopback reads its own availability from the same per-Core store it now feeds through the in-process core-link — no `coreId === LOOPBACK_CORE_ID` branch inside `useCliAvailability` or `NewAgentDialog`.
- [ ] Error copy for a missing agent names the Core ("codex is not on PATH on `Core name`") so an operator with several Cores knows *where* to install.

**References:** `docs/adr/0005-singular-ui-across-cores.md`; `CONTEXT.md` (CLI availability, CLI availability is Harness-published state rule).
