# Core is the machine, Harness is the CLI

"Harness" was a homonym. It named the installable daemon bundle on a VM, and — as `AiRuntimeHarness`, literally `type AiRuntimeHarness = TaskAgent` — it also named the agentic coding CLI a session drives. One word, two concepts, and the split is the single largest contributor to this repo reading as confusing. The vocabulary is now fixed: **a Panel controls many Cores; a Core runs many sessions; each session drives one Harness** (`claude-code`, `codex`, `cursor-cli`, `opencode`). Core and Panel are the two foundations; every other term takes its role from them.

So the word "harness" does not go to zero. It survives in exactly one sense — the CLI — and the machine sense is what dies. That makes this two renames running in opposite directions, not one sweep:

| Sense | Was | Is |
|---|---|---|
| The machine / daemon | `Harness` | **`Core`** |
| The agentic CLI a session drives | `TaskAgent` / `AiRuntimeHarness` | **`Harness`** |

**"Agent" is retired as domain vocabulary in both directions.** It reads as either the machine or an autonomous actor and is neither: a Harness is a vendor's program that Actana runs, not a part of Actana and not a thing with agency in our domain. Retiring it is the second rename — `TaskAgent` → `Harness`, `TASK_AGENTS` → `HARNESSES`, `AGENT_REGISTRY` → `HARNESS_REGISTRY`, `isTaskAgent` → `isHarness`, `agent-cli-config.ts` → `harness-cli-config.ts`. Two exceptions, both external conventions rather than our vocabulary: macOS **LaunchAgent** is an OS term, and `AGENTS.md` / `docs/agents/` are filenames coding CLIs discover by exact name (ADR 0016 D45).

**The Harness family is open.** New harnesses are added over time, so any table or dispatch keyed by harness type must be extensible — no `if harness === 'claude-code'` branches in feature code; add a capability entry to the harness registry instead. The Panel treats every harness the same over the core-link: **differences between harnesses live inside the Core process, never in the Panel.** This is the property that makes the CLI sense worth its own word. A Core is a machine we install and operate; a Harness is a third-party program whose set we do not control and whose per-vendor quirks must stay quarantined on the far side of the wire.

The counterpart constraint on the machine sense is that "Core" is one word for both the installed thing and the Panel's handle on it. The vocabulary this ADR replaces used `Core` for the Panel-side name and `Harness` for the machine-side name of the same unit, and instructed readers to switch between them by perspective. The observation underneath it was right — they are the same unit seen from two sides — but naming the sides separately taught every reader that there were two, which is the confusion being deleted. One unit, one word, and the perspective is not part of the name.

## Considered Options

- **"Agent" for the CLI sense (rejected).** The obvious candidate — it is what the vendors' own docs say, and `TaskAgent` was already the type name. Rejected because the word is ambiguous in exactly the dimension that matters here: to a reader arriving at this repo, "agent" reads as the remote machine (as in "agent host", the sense `docs/upstream/` still uses) or as an autonomous actor with goals. Both readings are wrong, and the first one collides with `Core`, which is the collision this ADR exists to end. Keeping "Agent" would also leave the repo with three words for two concepts.
- **A mechanical `s/Harness/Core/` sweep (rejected).** Treats the homonym as a typo. It produces `AiRuntimeCore` and hands "Core" the same two conflicting meanings "Harness" had, moving the problem rather than solving it.
- **Rename the machine sense now, the CLI sense later (rejected).** Splitting leaves a window in which the repo says Core, Agent *and* Harness for two concepts — strictly worse than the state it is fixing. Both land as one sweep (ADR 0016 D2).
- **A new word for the CLI, keeping "Harness" for the machine (rejected).** Cheaper in diff size, since the machine sense has the larger footprint. Rejected because the machine sense already had a better word in daily use — the Panel's registry, its schema tables (`cores`, `core_secrets`) and its UI all said Core before this ADR. Inventing a third term to protect the weaker of the two claims on "harness" adds vocabulary instead of removing it.

## Consequences

- Both renames land as a single PR across 233 live files (ADR 0016 D2). `packages/harness/` → `packages/core/`, `@actana/harness` → `@actana/core`, the eight `AC_HARNESS_*` variables → `AC_CORE_*`, the systemd unit → `actana-core.service`, and release assets → `actana-core-<version>-<target>.tar.gz`.
- **There is nothing to migrate.** No Core tarball has ever been published under any name, and the Panel's schema was already Core-named, so there is zero persisted-data impact and no compatibility shim. The only harness-named artifact on disk is the old systemd unit, which `actana setup` removes if it finds one.
- This ADR takes **0013** even though a second decision independently claimed that number. The rename is the sweep every other decision is applied on top of, so it takes the low number; the other two shift to 0014 and 0015 (ADR 0016 D44).
- Three ADR files are renamed (`0001-detach-core-from-panel.md`, `0003-core-install-and-registration.md`, `0004-core-owns-write-path.md`), but no ADR body is edited. The ten that were written in the old senses — 0001 through 0010 — keep their original wording under a one-line header note telling the reader how to translate it. Rewriting decided history to match new vocabulary would make the record lie about what was decided and when.
- The `CONTEXT.md` **Core** entry is deleted outright rather than reworded. It read *"`Core` is the Panel-side name; `Harness` is the machine-side name for the same unit. Use `Core` when talking from the Panel's perspective, `Harness` when talking about what's installed on the machine"* — the sentence this ADR exists to remove. Rewording an entry whose job was to institutionalize the split preserves its framing, so it goes and a fresh one takes its place.
- The glossary entries that replace it are below, as landed in `CONTEXT.md`. **Core** and the openness clause of **Harness** are the replacement text supplied with the decision; where `CONTEXT.md` already carried operational facts the supplied text did not restate, those are kept rather than dropped.

  > **Core**: A machine running the Actana Control daemon. Hosts projects, tasks and sessions; owns its own SQLite; the single source of truth for all work on that machine. A Panel drives zero-or-more Cores over the core-link. _Avoid_: harness, server, backend, node, agent host.
  >
  > **Harness**: The agentic coding CLI a session drives — `claude-code`, `codex`, `cursor-cli`, `opencode`. Installed on a Core, spawned into a PTY by it, and never touched by the Panel except as an id and an availability status. A Harness is a vendor's program that Actana runs, not a part of Actana. The family is **open**; any table or dispatch keyed by harness type must be extensible, and differences between harnesses live inside the Core process, never in the Panel. _Avoid_: agent, task agent, AI runtime, tool, model.
  >
  > **Session**: The live or replayable conversation backing a Task — the PTY stream plus the harness's own session id. A Core runs many sessions; each session drives exactly one Harness. Replayable after Panel reconnect via the Core's event log. _Avoid_: conversation, thread.

- When `CONTEXT.md` and `domain-model.md` are eventually merged into `docs/architecture/vocabulary.md` (ADR 0016 D42 — that file does not exist yet), these three entries are what carries over. The two rules that follow from the open family are stated once, here; `domain-model.md` records only the roster and cites this ADR for the rules, so there is one authority to keep current rather than three.
