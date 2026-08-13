# A folder crosses as one streamed tar

[ADR 0028](0028-file-bytes-cross-https-not-the-core-link.md) settles that file bytes cross the Core's HTTPS origin. This record settles the shape of a *folder* on that surface: **one request, one streamed tar, per-entry progress**, and a tar codec written out in this repository rather than taken from npm.

The alternative — a request per file — is the one that looks obviously simpler until you name the folder. The folder is `node_modules`.

## The decisions

**D1 — A folder is one request carrying one tar, streamed.** `GET` of a directory answers `application/x-tar`, produced as the tree is walked. `PUT` with `Content-Type: application/x-tar` unpacks the body as it arrives. Neither side ever holds the whole archive.

The argument is the shape of the cost. **Per-file, a transfer is latency-bound**: 40 000 files at even 2 ms of round trip each is eighty seconds spent waiting rather than moving, before a single byte of payload is counted, and it does not improve with a faster link. **As one stream it is bandwidth-bound**, which is the only regime where a faster link makes a transfer faster. For the folders this feature exists to move — a dependency tree, a build output, a repository — that is the difference between a feature and a demo.

Streaming rather than buffering because the folders are larger than memory and a Core is somebody's machine. Buffering a tar to measure it would mean either holding gigabytes in RAM or writing a temp copy of the thing being copied.

**D2 — Tar, not zip, and not a custom framing.** Tar carries POSIX permission bits natively, which is what makes "the folder keeps its executable bits" a property of the format rather than a sidecar this project maintains. It is streamable in both directions by construction — header, bytes, header, bytes — with no central directory at the end, which zip has and which is precisely what makes zip awkward to write without knowing the whole tree first. And `tar -xf` on the far end works, which matters the first time somebody has to debug a transfer by hand.

**D3 — The tar codec is written out here rather than taken from npm.** Roughly three hundred lines of ustar in `files-tar.ts`, read end to end by a reviewer.

This is a dependency added to the **Core bundle**, which [`CONTRIBUTING.md`](../../CONTRIBUTING.md) already says wants an ADR — so the question is asked properly rather than settled by `pnpm add`. The answer is that the unpack side is this ticket's attack surface (D4), every rule it enforces is a rule about *this* Core's disk and this Core's Project roots, and a library whose entire job is to extract faithfully would have to be fought on every entry: intercept each path, re-resolve it against a root the library does not know about, and refuse entry types the library is trying to create. What is left of the library after that is the header parser, which is the part that is two hundred lines and has not changed since 1988.

Against that: a well-known library gets more eyes and more fuzzing than a file in this repository will. That is a real cost and it is accepted, because the code that would actually be load-bearing here — the validation — would be ours either way, and it is better placed where it can refuse an entry before the write than wrapped around a library that is already writing.

**D4 — Unpack validates every entry path *after* resolution, never before.** For each entry, the destination is joined to the unpack root, the parents are resolved through whatever symlinks exist **at the moment that entry is written**, and the result is checked against the Project root. Only then is anything created.

The ordering is the whole decision. A `..` inside a tar entry is the classic escape and a string check catches it, but the string check is the cheap half. The half that matters is the **two-entry attack**: entry one is a symlink named `link` pointing at `/etc`, entry two is a file named `link/passwd`. Every string in that archive is innocent. A validator that ran once over the entry list before unpacking would pass both, and the filesystem between them is the only thing that knows they add up to a write outside the root.

The same applies to the *second* place a path can come from. A pax extended header or a GNU long-name entry overrides the following entry's name, so the override is validated too — an implementation that checked the ustar name and then let pax replace it would pass every other test in the suite.

**D5 — Refused entry types are named, not lumped.** Absolute entry paths, `..` segments, entries resolving outside the root, symlinks whose target resolves outside, hardlinks whose target resolves outside, and character devices, block devices and fifos — each with its own code, so the failure line in the progress stream says which rule was broken.

Device nodes and fifos are refused rather than skipped, and the asymmetry with the pack side is deliberate. **Packing** skips a socket or a fifo, because the operator asked for the folder they have and a `.sock` left by a running daemon should not fail their upload. **Unpacking** refuses one, because there the archive is asking this Core to *create* a device node, which is not a thing a file transfer ever means and is the shape of request worth being loud about.

Refusal aborts the transfer rather than skipping the entry: a partially applied archive is worse than a failed one, because an operator can retry a failure and cannot see a skip.

**D6 — The final path component is never followed; the parents always are.** An entry named `notes.txt` creates `notes.txt`. If something is already sitting there — including a symlink — it is removed and replaced, not written through.

`open(…, "w")` follows a symlink. Without this rule, a tar that plants `notes.txt → /somewhere/else` and then writes `notes.txt` would put its bytes in that other file with every path check passed, and leave `notes.txt` still a symlink; an operator who asked to replace a file would have silently overwritten a different one. The parents *are* resolved, because that is where an escape actually hides (D4) — `vendor/lib.js` under a `vendor` that points out of the Project is refused, and refusing the last component too would only break the ordinary case of overwriting a file that happens to be a link.

**D7 — Ownership is flattened; the mode is preserved.** Every entry is written with uid/gid 0 and no `uname`/`gname`, and the permission bits are masked to `mode & 0o777`.

A transfer crosses machines that do not share a `/etc/passwd`, so preserving numeric ownership restores a stranger's uid at the far end. The bit that has to survive is the executable one and it rides `mode` — which is set explicitly after the write rather than only via `open(…, mode)`, because `open` applies a mode only when it *creates* a file and an overwrite would otherwise keep the old bits. Masking to `0o777` also drops setuid, setgid and sticky: creating a setuid file out of an uploaded archive is not something this surface should be able to do by accident, and no file transfer means it.

**D8 — Entries are emitted in sorted order per directory.** The same tree produces the same bytes twice. That makes a transfer diffable, makes a test assertable against a fixture, and costs one `sort` per `readdir`.

## Alternatives considered

- **One request per file (rejected, D1).** Simplest possible surface, resumable per file for free, and every request independently confined. Rejected on latency: a dependency tree is tens of thousands of files, and per-file makes the wall clock a function of round-trip time rather than bandwidth. It also loses the executable bit unless every request carries a mode header, which is re-inventing a tar header one field at a time.
- **Zip (rejected, D2).** Better tooling on an operator's laptop, and random access into the archive. Rejected because its central directory lives at the end, which makes streaming a write awkward and streaming a read impossible without seeking, and because permission bits are an extension field rather than the format.
- **Tar plus gzip (rejected, D1).** Would cut the wire cost on compressible trees. Rejected as out of scope rather than wrong: it is a `Content-Encoding` away and can be added without changing anything here, and the folders that dominate — `node_modules`, build output, media — are largely incompressible. Adding it now would mean choosing a compression level on behalf of a link nobody has measured.
- **`node-tar` or `tar-stream` from npm (rejected, D3).** More eyes, more fuzzing, less code here. Rejected on where the validation would have to live: every rule in D4 through D7 is about this Core's Project root, so it would be ours regardless, wrapped around a library already committed to writing what it is given. What the dependency would actually be carrying is the header parser.
- **Validate the entry list up front, then unpack (rejected, D4).** Reads as more careful — refuse the whole archive before touching the disk. Rejected because it cannot see the two-entry symlink escape: at validation time `link` does not exist yet, and by the time it does the validation is over.
- **Skip a bad entry and continue (rejected, D5).** Would let a mostly-good archive land. Rejected because a skip is invisible: the operator sees a successful transfer with a file missing, which is the failure mode that gets discovered a week later.
- **Preserve uid/gid (rejected, D7).** Faithful to the source machine. Rejected because the two machines do not share a user database, so faithfulness produces files owned by whoever happens to hold that numeric id on the destination.

## Consequences

- **`files-tar.ts` is code this project maintains**, including its pax and GNU long-name handling. It is covered both ways — against `tar(1)` in both directions where the binary exists, and against hand-built hostile archives that `tar(1)` will not produce.
- **The hardening suite builds its archives by hand**, because every case in it is a shape a cooperating tool refuses to emit. That is the suite to extend when a new escape is thought of.
- **A folder download is `Transfer-Encoding: chunked` with no `Content-Length`.** Measuring it would mean walking the tree twice. A client cannot show a percentage for a folder download, and that is the trade.
- **Hardlinks between files inside a packed folder are not detected**, so two hardlinked files pack as two independent copies. A transfer between machines cannot preserve inode identity anyway; the archive is larger and the result is correct.
- **The tar carries no `sha256`**, and does not need to: the read direction's digest is computed by whoever receives the bytes, in the same single pass ([ADR 0028 D5](0028-file-bytes-cross-https-not-the-core-link.md)).
- **A transfer is not atomic** and does not claim to be. A refusal mid-archive leaves the entries that were already written. What is guaranteed is that nothing was written outside the Project root — which is the claim [ADR 0027 D5](0027-the-filesystem-is-the-model.md) is careful about the scope of, and which holds here regardless of trust model because an unpacker writing outside its destination is a defect either way.
