# The Panel is a dumb pipe for file bytes, and it is the end that holds the credentials

A file dropped on a Project in the Panel has to reach the Core that owns that
Project's disk. Three facts decide how, and none of them is negotiable:

- **A browser cannot present a client certificate.** The Core's `/v1/…` file
  routes sit on the same mTLS server as the core-link WebSocket, behind
  `requestCert: true, rejectUnauthorized: true` (ADR 0002, ADR 0028). No page,
  no `fetch`, no `XMLHttpRequest` can satisfy that handshake.
- **The operator's browser usually cannot route to a Core at all.** The
  reference deployment publishes no Core port (`deploy/docker-compose.yml`); the
  Panel reaches it over the compose network and nothing else is meant to.
- **The Panel service already holds the credentials.** It dials every core link
  from `core-link-manager.ts` with the pinned CA, the client certificate and the
  bearer sealed at rest — that is what makes it a service rather than a window.

So the bytes go **browser → Panel → Core**, and the Panel is the mTLS client for
the file routes exactly as it already is for the core link. #129 F11 names the
shape of the middle arrow — *the Panel is a dumb pipe* — and this ADR records
which end holds the credentials, which was the open question, along with the
three things "dumb pipe" is actually worth.

This is written down rather than left to a code comment because it looks like a
contradiction of ADR 0012 and is not, and because the alternative — handing a
browser something that lets it talk to a Core directly — is the kind of idea that
comes back every eighteen months with a new justification.

## Decisions

**D1 — The browser's transport for file bytes ends at the Panel; the Panel's
transport to the Core carries the mTLS material.** The browser talks to
`/api/cores/:coreId/projects/:projectId/files…` with the Operator's session
cookie, which is the only credential it has and the only one it needs. The Panel
resolves the Core, presents the certificate and the bearer, and forwards.

ADR 0012 is not contradicted: it settles the **live UI transport** — one
multiplexed panel link per tab, carrying `coreId`-tagged frames — and its first
sentence says every core link terminates *inside the Panel service* for precisely
the reason repeated above. What "the core link is the browser's" means there is
that the *frames* are the browser's and the Panel routes them without
translating; it has never meant the socket is.

**ADR 0022's consequence sentence is the one that needs correcting**, and it is
corrected here rather than quietly worked around: *"The Panel server has no
transport of its own to a Core — the core-link is the browser's (ADR 0012) — so
it cannot join a Core's projects to its own filing."* The conclusion still holds
and its reasoning still holds *for a project list*, which arrives over the panel
link inside a browser. The general claim does not: the Panel service is the one
process in the system that **does** have a transport of its own to a Core, and
the file routes use it. Presentation is still joined client-side; nothing about
project filing changes.

**D2 — The pipe buffers nothing, unpacks nothing, and validates no path.** Each
is a decision, not an omission:

- *Buffers nothing.* The browser's request body is handed to the Core's socket as
  a stream and the Core's answer comes back the same way. Nothing on either path
  calls `arrayBuffer`, `text`, `json`, `formData` or `blob`. This is the trap
  #169 names — a streaming proxy is one word away from a buffering one — and it
  was already sitting in `vite-api-plugin.ts`, which read every request body into
  a `Buffer` while `bin/panel.mjs` streamed the same request correctly.
- *Unpacks nothing.* A folder crosses as one tar (ADR 0029) and is opened on the
  machine that owns the disk. A Panel that unpacked would be a second copy of the
  hardened unpacker, running where there is no filesystem to validate against.
- *Validates no path.* `..`, an absolute path, a symlink leaving the Project root
  — all forwarded exactly as written, and refused by the Core with the Core's own
  code (F3, ADR 0027 D5). One place validates paths: the machine that owns the
  disk. A Panel that pre-checked would be guessing about a filesystem it cannot
  see, and on the day the two checks disagreed the Panel's would be both the
  wrong answer and the one that got used.

The Core's statuses pass through unchanged for the same reason, including
`409 transfer-in-progress` (F8) and `507 insufficient-storage`.

**D3 — The `files` capability rides the dial status.** It is a fact about the
*current connection*, like `coreVersion` beside it: a Core can be upgraded into
the file surface or downgraded out of it, and a remembered answer would leave a
browser drawing a view whose every request 404s. The service holds the link, so
the service learns it; every tab already folds each dial push into its row. A
Core that announces none is refused by the Panel **before a request goes out**,
so an operator reads *this Core has no file surface* rather than a 404 that looks
like an outage. That is not `needs-update` (ADR 0024 D11) and never renders as
one.

**D4 — The browser gets its own small client, not the SDK's.** `@actana/sdk`'s
`project.files.*` sends through an undici `Agent` — a Node object, and the only
seam by which a client certificate reaches `fetch` at all (ADR 0025, #151). It
cannot run in a tab, and this is exactly the transport split D1 describes rather
than a gap in the SDK.

So the browser has ~200 lines in `lib/core-files.ts`, and the sharing is chosen
per layer:

- **Types are shared.** `CoreFileEntry` and `CoreFileProgress` are imported as
  types from the SDK and erased at build, so the manifest shape has one
  definition and no runtime dependency crosses.
- **URL shapes are shared.** The Panel's proxy subclasses `CoreFiles` to reach
  its `protected` `fileUrl`/`listUrl`, which the SDK explicitly invites. #218 was
  a drift between the SDK's URL and the Core's route; a third hand-rolled copy in
  the Panel would be a third thing to keep in that agreement, and the one
  furthest from the test that pins it.
- **Parsing is not shared.** The SDK's `list`/`upload` turn NDJSON into typed
  objects, which is right for an SDK caller and wrong for a pipe: parsing and
  re-serialising a stream is how a Panel ends up owning a shape it is meant to be
  forwarding.

**D5 — A file view is not presentation.** ADR 0022 gives a Core-owned Project a
Panel-side `project_presentation` row for its group, card image and launch URL —
the Panel operator's own filing of somebody else's Project, joined client-side.
A Project's files are the opposite kind of thing: they are the Core's disk, read
live, owned entirely by the machine. Nothing about the file view touches that
table, and no listing, path, digest or upload record is persisted anywhere in the
Panel. The filesystem is the model (ADR 0027 F1); a Panel-side index of it would
be stale the moment an agent wrote, which on these machines is constantly.

## Considered Options

- **Give the browser a short-lived signed ticket and let it talk to the Core
  directly (rejected).** The attractive one: the bytes would go from the laptop
  to the Core with the Panel out of the path entirely, which is one fewer hop and
  one fewer process to size. Rejected on two independent grounds, either
  sufficient. The Core requires a *client certificate*, so a ticket would mean
  either relaxing that for the file routes — an anonymous TLS surface on the
  machine that runs the agents — or shipping a private key to a browser, which is
  not a trade-off but a category error. And the Core is normally unroutable from
  the operator's browser anyway, so for the reference deployment this option does
  not merely cost security, it does not function.

- **Terminate the upload in the Panel and re-send it from there (rejected).**
  What most frameworks do by default, which is why it needs an explicit
  rejection: `await request.formData()`, one line, and a multi-gigabyte drop is
  in the Panel's heap. The Panel is a small container beside a browser and a Core
  that are both perfectly capable of streaming; making it the only part of the
  system that has to be sized for the largest file anyone will ever drop is a
  strange place to spend memory. It is also the failure that passes every
  functional test — the file still lands — so it is pinned by tests that watch
  *when* the first byte arrives and *how much* memory it took, in
  `core-files-streaming.test.ts` and in the deployed leg of
  `scripts/e2e-panel-smoke.mjs`.

- **Have the Panel drive the SDK's `project.files.*` and re-emit the results
  (rejected).** Tempting because it reuses code that exists and is tested. It
  would parse the Core's NDJSON into objects and serialise them back out, which
  means the Panel now has an opinion about every line shape — including the ones a
  newer Core invents — and a Core-side addition becomes a Panel release. The
  types and the URL builders are reused instead (D4); the stream is not touched.

- **Put the `files` capability on the Core registry row (rejected).** It would
  survive a restart and need no push. Rejected because it is not a property of a
  registration: the registry row is what the operator pasted, and the capability
  is what this connection's `ready` frame said a moment ago. A stored answer
  outlives the Core version that produced it.

- **Let the Panel reject obviously bad paths before forwarding (rejected).**
  Cheap, and it would save a round trip on a typo. Rejected because it creates a
  second path validator with no filesystem behind it — it cannot see a symlink,
  cannot resolve a Project root, and would be wrong in exactly the interesting
  cases while being confidently right about the boring ones. F11 says one place
  validates paths, and half a validator in the other place is worse than none.

## Consequences

- **A Panel restart kills an upload in flight.** The pipe is stateless and holds
  no resumable transfer; the Core's write lease is released when the socket
  drops, and the operator drops the file again. Resumable transfer is a real
  feature and is not this one.
- **The operator's socket is the transfer's lifetime, and the Panel had to be
  taught to notice it (#225).** "The Core's write lease is released when the
  socket drops" above was true only of the socket the *Core* can see. A browser
  that goes away after its body is already sent leaves the Panel with nothing
  left to fail: the request stream has ended, so the transfer ran to completion
  holding that Project's lease, and the operator's next drop was refused
  `409 transfer-in-progress` by an upload the Panel had already reported dead.
  So the two hosts now hand `request.signal` down to `pipeToCore`, aborted when
  the client's connection closes before its answer was finished. A cancelled
  transfer leaves a partial file, which is what every interrupted write leaves
  and what the next drop overwrites — the alternative is a doomed
  multi-gigabyte upload holding a lock nobody is waiting on.
- **Translating between Node and `fetch` is one module, not one per host
  (`server/node-http-bridge.ts`, #225).** `bin/panel.mjs` and the Vite
  middleware had written it twice and disagreed twice: about buffering a request
  body (D2's own example), and about an answer whose body fails half-written —
  where production's `Readable.fromWeb(body).pipe(res)` left the source's
  `'error'` event unhandled, which in Node ends the process. The Core raises one
  deliberately (`res.destroy()` on any interrupted stream, so a truncated body
  cannot read as a whole one), so closing a big listing could take the Panel
  down and every request in flight on it — the upload just started, the file
  view beside it — died together with the browser's `Failed to fetch`. The
  bridge is exported from the server bundle for the same reason
  `attachPanelLink` is: only the host owns the socket, and only the bundle can
  guarantee both hosts run the same translation.
- **The Panel's outbound connection pool is now per Core rather than per
  request.** `createCoreFilesFetch` builds an undici `Agent` and an `Agent` is a
  pool, so one is kept per Core and re-keyed when its credentials change — a
  cached sender presenting a retired certificate would be refused at the
  handshake with an error naming no cause.
- **A folder dropped in the browser crosses as N requests, not one tar.** The CLI
  packs a folder precisely so a `node_modules` is bandwidth-bound rather than
  latency-bound (F4, ADR 0029), and that argument applies here too — so this is a
  known shortfall rather than a settled shape. Packing a tar in a tab has its own
  memory story and is worth doing on its own ticket; what ships first is the drop
  #129's done-means asks for.
- **A file dropped in the browser lands without its mode bits.** F4's second
  clause — a tar *"carries the executable bit natively"* — is the half a browser
  cannot answer by packing a tar: `uploadProjectFile` sends
  `x-actana-file-mtime`, but the DOM `File` it holds exposes no mode, so there is
  nothing to put in `x-actana-file-mode`. The pipe is already ready for it (the
  header is in both forwarded allowlists, and the Core applies it), so a shell
  script dropped in the browser arrives without `+x` where the same file sent by
  the CLI keeps it. The follow-up ticket therefore inherits **both** of F4's
  arguments, and this one needs a source of mode that is not the drop event.
- **`docs/external-api.md` gains no entry.** These routes are the Panel's own
  `/api/*` surface, behind the Operator session, and they forward to routes that
  document is already about. The Core's surface is the published one.
