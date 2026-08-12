# @actana/sdk

The Core client for [Actana Control](https://github.com/actana/control), and the
`core-link` wire protocol it speaks: frame schema, protocol version, codec,
transport.

A **Core** is a machine that runs AI coding sessions. This package is what talks
to one — over mutual TLS and a bearer token read from a registration blob. The
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

## Versioning

One version line across the Core, the Panel, this SDK and the CLI, published on
the same tag that builds the container images. Pre-1.0, **each minor is the
breaking-change unit** — a patch never changes a shape.

`CORE_LINK_PROTOCOL_VERSION` is a separate number with its own compatibility
rule, exported from `@actana/sdk/core-link-frames`. A Core and a client
negotiate on it at connect time; it does not move with the package version.

## License

MIT — see [LICENSE](https://github.com/actana/control/blob/main/LICENSE).
