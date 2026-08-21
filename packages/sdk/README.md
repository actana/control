# @actana/sdk

The Core client for [Actana Control](https://github.com/actana/control), and the
`core-link` wire protocol it speaks: frame schema, protocol version, codec,
transport.

A **Core** is a machine that runs AI coding sessions. This package is what talks
to one — over mutual TLS and a bearer, out of the credential a pairing issued
(`@actana/sdk/core-pairing` redeems a short code for one). The
protocol ships with the client rather than beside it
([ADR 0025](https://github.com/actana/control/blob/main/docs/adr/0025-the-protocol-ships-with-the-client.md)):
there is one definition of a frame, and it is here.

```sh
npm install @actana/sdk
```

Node **22 or newer**. Published as compiled JavaScript with type declarations
beside it, with
[provenance](https://docs.npmjs.com/generating-provenance-statements) — every
release is attested to the workflow and the commit that built it.

## Two layers, one socket

```js
import { CoreClient } from "@actana/sdk/core-client";
import { CoreSession } from "@actana/sdk/core-session";

const client = CoreClient.fromRegistrationBlob(blob, { connectTimeoutMs: 15_000 });
const info = await client.connect();

const session = await CoreSession.start(client, {
  projectId,
  cwd,
  harness: "claude-code",
  prompt: "summarise this repo",
});
await session.waitForIdle({ timeoutMs: 300_000 });
console.log(session.screen());
```

- **Transport** — `@actana/sdk/core-client` connects, authenticates, correlates
  requests to responses, and surfaces the unsolicited streams. `@actana/sdk/durable-core-client`
  is the same surface with heartbeats, reconnection with backoff, and an event
  cursor, for a long-lived consumer.
- **Session** — `@actana/sdk/core-session` starts a session, waits for its
  Harness to come up, delivers a prompt, and reads the result.

I/O is programmatic and never a TTY: `send(text)`, `onData(…)`, `screen()`.
Raw mode and terminal handling belong to a terminal program — see `@actana/cli`.

`packages/sdk/examples/start-a-session.mjs` in the repository is a complete
plain-Node script, start to finish.

## Files

A Project's files are reached over the Core's HTTPS routes — the same origin,
certificate and bearer as the socket, but not the socket itself. File bytes
never cross the core link, because chunking a multi-gigabyte upload into JSON
frames would stutter every terminal pane sharing it
([ADR 0028](https://github.com/actana/control/blob/main/docs/adr/0028-file-bytes-cross-https-not-the-core-link.md)).

```js
import { createReadStream, createWriteStream } from "node:fs";
import { Writable } from "node:stream";

const project = client.project(projectId);

for await (const entry of project.files.list({ path: "src" })) {
  console.log(entry.path, entry.size, entry.sha256);
}

for await (const line of project.files.upload({
  path: "notes.txt",
  body: createReadStream("./notes.txt"),
})) {
  if (line.type === "entry") console.log(line.result, line.path); // "overwritten notes.txt"
}

const { stream, size } = await project.files.download({ path: "dist/bundle.js" });
await stream.pipeTo(Writable.toWeb(createWriteStream("./bundle.js")));
```

**Everything streams, and nothing runs ahead of you.** `upload` takes a stream
and gives back the Core's NDJSON progress as an async iterable — one line per
entry, each saying whether it was `written` or `overwritten`. `download` returns
a **stream, never a buffer**: a gigabyte file is never resident. `list` is an
async iterable over the tree. All three are pull-driven, so a slow consumer
becomes backpressure all the way to the Core rather than a queue filling up in
memory here.

Two things worth knowing before you call them:

- **Ask first.** `client.canUseFileRoutes()` is false against a Core that
  predates the file surface, and every call throws
  `CoreFilesUnavailableError` with the reason rather than sending a request such
  a Core would answer with a bewildering 404. That Core is not broken and does
  not need updating.
- **One write per Project, and no retries.** A second concurrent write is
  refused with `CoreFilesConflictError` (`code: "transfer-in-progress"`)
  immediately. This package never retries it for you: the conflict is a
  decision for you to make, and a silent retry would turn a clear refusal into a
  hang.

A folder crosses as one tar. This package does not build them — hand `upload` a
tar stream with `kind: "tar"`, and `download` of a directory returns one with
`kind: "tar"`.

## Versioning

One version line across the Core, the Panel, this SDK and the CLI, published on
the same tag that builds the container images. Pre-1.0, **each minor is the
breaking-change unit** — a patch never changes a shape.

`CORE_LINK_PROTOCOL_VERSION` is a separate number with its own compatibility
rule, exported from `@actana/sdk/core-link-frames`. A Core and a client
negotiate on it at connect time; it does not move with the package version.

## License

MIT — see [LICENSE](https://github.com/actana/control/blob/main/LICENSE).
