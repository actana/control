# 04 — Core-link `projectsMutate` + real `tasksMutate` / `sessionsList` handlers

**What to build:** Add a `projectsMutate` frame to `src/shared/core-link-frames.ts` (create / rename / archive project; the Harness validates the VM path — resolvable, absolute, not-a-file, per CONTEXT.md "a project's path is a VM path"). Promote `tasksMutate` from the schema placeholder at `core-link-frames.ts:126-131` to a real handler that writes task rows to the Harness's SQLite (create + update; the exact op set matches what the loopback stateful server exposes today). Replace the `sessionsList → []` stub in `pty-core-link-server.ts` with a real read against sessions/tasks tables so reattach works on remote Cores. Along the way, decide and record the ownership question the spec's Open Questions section flags: does the Harness process own the writes directly against its SQLite, or does it forward over loopback HTTP to a bundled `src/server/` sibling process (per ADR 0001)? Record the decision as ADR 0004 if it changes ownership from what ADR 0001 assumed.

**Blocked by:** ~~02 — no schema means no rows to mutate.~~ (Landed in a23ae3f.)

**Status:** done

- [x] `src/shared/core-link-frames.ts` gains a `projectsMutate` frame with typed create/rename/archive variants and a discriminant-typed response.
- [x] `tasksMutate` in `core-link-frames.ts` is no longer a placeholder — its request/response schema covers the real create/update ops the loopback API exposes today (discriminated `op: "create" | "update"`).
- [x] `electron/pty-core-link-server.ts` handlers for `projectsMutate`, `tasksMutate`, `sessionsList` are real — no `null` / `[]` stubs remain for those three frames (fallback stubs kept only when no `mutationPort` is configured — a PTY-only Harness is still valid, matches the `queryPort` pattern from issue 07).
- [x] The Harness validates project paths server-side: absolute, resolvable, not a file, actionable error on failure (`validateProjectPath` in `src/shared/harness-mutations.ts`, wired through `electron/harness-mutation-store.ts` using `fs.statSync`/`path.isAbsolute`).
- [x] Writes go through whatever ownership path the ticket chooses; if the choice diverges from ADR 0001, an ADR 0004 is filed under `docs/adr/` recording the decision + rationale — filed as `0004-harness-owns-write-path.md`.
- [x] Round-trip test: dial a Harness → `projectsMutate` create → `projectsList` returns the new project → `tasksMutate` create → `tasksList` returns the new task → `sessionsList` returns any spawned sessions — covered by `PtyCoreLinkServer projectsMutate / tasksMutate / sessionsList (issue 04) > round-trips the full create-project → list → create-task → list → sessions flow` in `electron/__tests__/pty-core-link.test.ts`.
- [x] Existing loopback behaviour is unchanged (the local API still serves the Panel as before; frames exist for remote Cores).
