# A Core-owned Project has a Panel-side presentation row, and its icons are Core facts

Editing or removing a Core-owned Project both failed, for the same underlying reason and with two different remedies. ADR 0005 puts a Project's row on exactly one Core and nowhere else; the Panel has no row for it. But the Edit-project dialog and the two Remove-project paths still addressed the Panel's own `projects` table over HTTP. `DELETE /api/projects/:id` 404'd, and `confirmRemoveProject` had no `catch` — the dialog closed, no toast appeared, the project was still there. `saveProjectEdits` sent the name over the core-link and then PATCHed icon, colour, group and image at the row that does not exist, so a save 404'd with the rename already applied: a partial write by construction.

The fields it was sending are not one kind of thing, and that is what this ADR settles.

**Icon and icon colour are Core facts, and get an `appearance` op.** They live in the Core's project row, already travel in `CoreLinkProjectSnapshot`, and `create` already accepts them — nothing could change them afterwards. A dedicated op rather than widening `rename` into a generic field patch, following the precedent `pin` set and ADR 0017 restated: the op earns its own `project:appearanceChanged` event kind, so a reconnecting Panel replays an icon change distinctly from a rename. `CORE_LINK_PROTOCOL_VERSION` → 0.15.0. No migration — `icon` and `icon_color` have been in the shared schema bootstrap since the fork.

**Group, card image and launch URL are Panel-local presentation, and get a `project_presentation` row.** These mean nothing on a Core: groups exist only in the Panel's database, the card image is bytes on the Panel's disk, and the launch URL names a port the operator's browser can reach. They are the Panel operator's own filing over someone else's project. So the Panel keeps a row keyed to the Core's project id, holding exactly those three fields plus the owning `coreId`, and joins it onto the Core's snapshot on read. `PATCH /api/projects/:id` stops being the wrong door: the presentation route upserts, because the first time an operator files a project there is nothing to update.

**Removal routes to the `archive` op that was already there.** Unlike the missing ops above, `archive` existed, was tested, and had zero callers anywhere in the Panel — the exact sibling of #18, one level up. Both remove paths now route through it, and the Panel's own leftovers that the Core's delete knows nothing about — the stored session-finish notifications, the presentation row, the image bytes — are swept on the same path the Panel's own DELETE already sweeps them on.

## Considered Options

- **Extending the `settings` op to carry the icons (rejected).** One fewer op and no new event kind. Rejected because `settings` means "remembered session settings" — what the New session button does — and an icon is not that. A reconnecting Panel would replay a re-icon as a settings change and refetch on an undifferentiated "something about this project changed", which is the thing dedicated ops exist to avoid.
- **A generic `updateProject` field patch replacing `rename` / `pin` / `settings` / `appearance` (rejected).** Genuinely tempting at four ops. Rejected on the same ground ADR 0017 rejected it: the frame stops documenting what a Panel is allowed to change, and every project edit collapses into one replay kind. The cost of four ops is four `case` arms; the cost of one patch is a contract that says nothing.
- **Making the icons Panel-local presentation instead (rejected).** It would need no protocol bump at all. Rejected because the columns are on the Core's project row already and `create` already writes them — a project would then render with one icon on the Panel that created it and another everywhere else, which is precisely the divergence ADR 0005 exists to prevent.
- **Making group / image / launch URL Core facts instead (rejected).** The symmetric option, and it would need no new table. Rejected because a group id names a row in *this* Panel's database; sending it to a Core would either strand a dangling id there or force groups onto the Core, which is a much larger claim than this bug justifies. Two Panels on one Core are meant to disagree about filing.
- **Writing a stub `projects` row on the Panel for each Core-owned project (rejected).** It makes every existing PATCH and image route work unchanged, which is a real attraction. Rejected because that row would then appear in `listProjects()` — the Panel's own list — as a duplicate of the Core's project, and every reader would need to learn to exclude it. A row that exists only to be filtered out is the shape ADR 0005 forbids in slower motion.
- **Keying presentation by `(coreId, projectId)` (rejected, for now).** Correct if project ids could collide across Cores. They cannot in any practical sense: ids are minted `p-<base36 ms>-<6 hex>` by the shared client-id generator. `coreId` is a column rather than half the key, which is what the orphan sweep needs anyway; promoting it to the key later is a migration, not a redesign.

## Consequences

- **Every Core must be updated alongside the Panel.** The minor moved, so a Core still speaking 0.14.0 is incompatible under the major.minor rule and renders as "needs update" (ADR 0005). An older Core would take the `appearance` frame and hit its own runtime `op` guard, which is a clearer failure than a silent drop but still a failure — the version gate is the honest place to say so.
- **The Panel now has state keyed to a row it does not own, and therefore an orphan problem.** A project deleted on its Core leaves a presentation row nothing else would collect — including deletes this Panel never witnessed, by another Panel or at the Core's own keyboard. Two sweeps answer it: the remove path deletes the row it just orphaned, and the project read, which has a Core's full project list in hand anyway, posts that list so the server can drop anything outside it. Neither sweep can fail the operation it rides on.
- **Presentation is read as one list and joined client-side.** The Panel server has no transport of its own to a Core — the core-link is the browser's (ADR 0012) — so it cannot join a Core's projects to its own filing. Every remote-project surface therefore goes through one mapper, `projectRowFromSnapshot`, which takes the snapshot and an optional presentation row. That mapper previously existed twice, copied, in `queries/index.ts` and `use-fleet.ts`.
- **The card image now has two owners and one file layout.** `ProjectImageOwner` is the seam: the Panel's project row for a Panel-owned project, the presentation row for a Core-owned one. Naming, stale-extension sweeps and the traversal guard are written once and neither owner is a special case. The image routes take `?coreId=`, which is what lets a first upload create the presentation row rather than 404 on a project it has never seen.
- **A Core-owned project's path is immutable, and the UI now says so.** A path is a VM path only the Core can validate, and no op carries one post-create, so the core arm has nothing to send it on. Rather than accept an edit and drop it — the half-save this ADR exists to end, reproduced at the field level — the Edit dialog disables the Working directory field for a Core-owned project, drops Browse… (which was gated on *exactly* the case that could not be edited), and says the folder is fixed. The missing-path dialog's "point the project at its new location from Edit project" branches on ownership for the same reason: for a Core-owned project the only honest advice is remove-and-add-again. Growing an op that carries a Core-validated path is the real fix, and is tracked in #104.
- **Ownership and browsing are two different Cores, and the dialog now takes both.** `initialCoreId` names whose disk the folder browser walks and falls back to the open Core; `projectCoreId` names who owns the row being edited and does not. They diverge exactly where the project rail edits a Panel-owned project while a Core is open — the case where a fallback would disable a path that is genuinely editable, and route its edits at a Core that has never heard of it.
- **`CONTEXT.md` gains **Project presentation**,** alongside **Remembered Session Settings**, which it is deliberately the mirror image of: one names the Core facts a Panel must not keep, the other the Panel facts a Core must not.

## Amended by ADR 0030 (#169)

The consequence above beginning *"Presentation is read as one list and joined
client-side"* argues from a claim that is too broad: **"The Panel server has no
transport of its own to a Core."** Its conclusion stands and nothing about
project filing changes — a project list arrives over the panel link, inside a
browser, and the Panel server still cannot join one to its own rows. But the
Panel service *does* have a transport of its own to a Core, and
[ADR 0030](0030-the-panel-is-a-dumb-pipe-for-file-bytes.md) uses it: file bytes
go browser → Panel → Core, with the Panel presenting the mTLS material it
already dials every core link with.

That ADR also draws the boundary this one implies but never had to state: **a
Project's files are not presentation.** `project_presentation` holds the Panel
operator's own filing of somebody else's Project — group, card image, launch URL
— and a Project's disk is the opposite kind of thing. Nothing about the file
view is stored on the Panel at all.

## Amended by #382 — the rail slot is a fourth presentation field

This ADR names exactly three presentation fields: group, card image, launch URL.
A fourth joins them, on the same reasoning and with one addition of its own:
**where a Core-owned pin sits on the Panel's rail.**

The rail is one strip of tiles holding this Panel's own pins and the pins of
every Core it is connected to. Reordering it wrote through `PATCH
/api/projects/pinned-order`, which validates the order it is given against the
Panel's `projects` table — so a rail with any Core pin on it was rejected
whole, and the drag sprang back with a toast. Dragging a Core pin into another
group failed the same way and for the reason this ADR already gives: `PATCH
/api/projects/:id` has no row to write.

The group half needed no decision — it is presentation, filed exactly as
`saveProjectEdits` already files it. The position needed one, because pin state
itself *is* a Core fact (ADR 0005, and **Pinned Task / Pinned Project** in
`CONTEXT.md`), so the obvious symmetric answer was a new core-link op writing
`projects.pinned_order` on the Core. That was rejected: **the rail spans
Cores.** A slot number in a sequence that interleaves three machines' pins with
the Panel's own is not a fact any one of those machines can hold — two Cores
would each believe they owned slot 2, and the merged list would sort by
whichever row happened to be created first. Whether a Project is pinned stays
Core-owned and unchanged; only its position among the pins is Panel-local, and
that is the operator's filing of somebody else's Project in exactly the sense
this ADR already means.

The two halves are **not one transaction**, and cannot be: they are two
requests against two tables, and the Core-owned half is transactional only
within itself. If the Panel's order write commits and the Core half then fails,
the rail is half-applied under a failure toast; the client reverts what it can
and re-reads the rest. Closing that would need a single endpoint owning both
tables, which is a larger claim than this amendment makes.

One consequence is worth stating because it constrains both write paths: the
two halves share **one numbering space**. A reorder sends the whole rail to
`PATCH /api/projects/pinned-order`, which now numbers its own rows by their
index in that rail and skips ids belonging to no row here, and sends the same
indices for the Core-owned rows to `PATCH
/api/project-presentation/pinned-order`. Numbering each owner densely over its
own rows would have left no integer free to place a Core's pin *between* two of
the Panel's, which is the ordinary shape of a mixed rail.

The read side keeps the shape this ADR set: one presentation list, joined
client-side. `projectRowFromSnapshot` still reports `pinnedOrder: null` — the
core-link snapshot has no such field and should not grow one — and the rail's
own fan-out (`lib/core-pins-engine.ts`) overlays the slot from the presentation
row it has already read for the group. Folding that overlay into the mapper is
the tidier home for it and is left to whoever next owns that file.
