# The task-mutation frame carries delete

Deleting a Session that lives on a Core failed. Every other task mutation — title, pin, icon, status, archive — dispatches through the Core-routing task-mutation dispatcher, but delete had nothing to route: `CoreLinkTaskMutation` offered `create` and `update` only. So all three delete call sites fell through to the Panel's own HTTP endpoint, which cannot find a row that lives in the owning Core's SQLite (ADR 0004/0005) and answers not-found. This ADR records the contract addition that fixes it, because it changes the wire.

**The frame gains a `delete` op.** `{op: "delete", taskId}`. On the Core it removes the row — SQLite's `ON DELETE CASCADE` takes the terminal logs, prompts, and token usage hanging off it, the same hard delete the Panel server performs for a Panel-owned row — and hands back the snapshot of what it removed, mirroring `archiveProject`. A row that is not there comes back as `task: null`, the way a missing row on `update` already does, rather than an `error` frame: the Panel treats "already gone" as success, and an error frame would make a double-click look like a failure. `CORE_LINK_PROTOCOL_VERSION` → 0.11.0.

**The Core appends `task:deleted`.** The same kind the Panel server emits for a Panel-owned row, so a reconnecting Panel replays a Core-owned delete through the handler it already has — the one that prunes that session's stored finish notifications. No new event kind, and no Panel-side translation layer.

**No pending-question clear rides along**, unlike the Panel server's delete. A pending question is an in-memory map on the *Panel* server, filled by the hooks route, which resolves the task against the Panel's own database — a Core-owned task never gets an entry to clear, and nothing on the Core tracks one. Recorded here because the symmetry with the Panel's delete otherwise looks broken.

## Considered Options

- **Reuse `update` with a sentinel — say `archived: "delete"` or a `deleted` flag (rejected).** It would have avoided the minor bump. Rejected because the row does not survive: the Core cannot return a patched snapshot, `updateTask`'s partial-patch contract stops describing what happens, and the event kind would have to be inferred from a field value rather than the op. `create`/`update` are discriminated ops precisely so the Core dispatches without sniffing fields.
- **Soft-delete the row instead (rejected).** Archive is already the reversible hide, and it is a distinct operation with its own event kind. A second, permanent hide would leave two rows-that-are-not-there with different rules and no way to reclaim the disk.
- **Route delete over the Panel's HTTP API by asking the Core for the row first (rejected).** No transport exists for it: the row is never in the Panel's database, so there is nothing for that endpoint to delete regardless of what the Panel knows about it.

## Consequences

- **Every Core must be updated alongside the Panel.** The minor moved, so a Core still speaking 0.10.0 is incompatible under the major.minor rule and renders as "needs update" (ADR 0005). That is the honest answer here: an unbumped Core would accept the frame's outer type and reject the op at the mutation store's runtime guard — a delete that reports an error per row instead of one Core that says it needs updating.
- **The Panel-local arm of the dispatcher answers `null` for a delete.** The Panel's DELETE route replies 204 with no body, so a deleted row and a missing one are indistinguishable from the caller's side. Every delete caller awaits and ignores the value; the alternative was an extra GET for a row about to vanish.
- **Teardown must precede the delete at every call site.** It always did in the project route; the terminal panel ran the two concurrently, which was harmless only while the delete could not reach the Core. Both halves now land on the same machine, and the cascade takes the `terminal_logs` a still-running PTY is writing to.
- **`deleteAllArchived` is routed but still unreachable for a Core-owned row.** A Core's archived rows do not cross the link (`queryTasks` selects `WHERE archived = 0`), so the Archived list it reads is Panel-only until #62 lands. Routing it now means that button goes live working, rather than going live already failing.
