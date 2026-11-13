# @actana/core-cli

The `actana` that ships inside a Core: the machine verbs (`install`, `place`, `setup`, `status`, `token`,
`pair`, `update`, `start`, `stop`, `restart`, `logs`, `harnesses`, `uninstall`, and the `daemon` the service
runs), with the client nouns handed to the published
[`@actana/cli`](https://www.npmjs.com/package/@actana/cli)'s `runClient`.

**Private, and never published.** The name `@actana/cli` belongs to the client CLI, which is released from
[actana/client](https://github.com/actana/client). This package depends on it at one exact version and binds the
ports `runClient` needs in `src/actana-cli-entry.ts` from its root exports: `core`, `harness`, `events`,
`session`, `files` and `shared` are the client's, `search` is not part of this release and is an unknown command
here. Build output is the CommonJS bundle `dist-tarball/actana-cli.cjs` that `scripts/build-core-tarball.mjs`
stages into the Core tarball as `app/actana-cli.cjs`.

Where the machine layer meets the client: the `current` pointer is written to both `current.txt` and `current.json`
(`packages/shared/src/blob-registry.ts`), because the published CLI reads `current.json` first.

## `actana task wait <watch-url>`

Waits for a Task by looping on its status URL (`GET /api/watch/<token>`, #950): no pairing, no key, the URL is the
credential. It asks again after the `pollAfterSeconds` the Panel answers with (clamped to 2-60 s, +-20 % jitter), waits
`Retry-After` on `429`, backs off up to 60 s on network errors and gives up after 10 minutes without one good answer.
One line on stderr per state change; `--json` prints the last answer on stdout. `--until-final` ignores the Session
states, `--timeout <minutes>` bounds the wait. It never prints the URL.

| Code | Meaning |
|---|---|
| 0 | done |
| 10 | failed |
| 11 | partial |
| 20 | needs-input |
| 21 | interrupted |
| 22 | idle-no-result |
| 30 | gone (410) |
| 31 | timeout |
| 1 | error |
| 2 | usage |

For a caller without `actana`, the same loop as a `curl` one-liner (it waits for a result and stops on any HTTP error,
including `410` and `429`; the usage text carries the same line, and #952's guide must reuse it, not reword it):

```sh
u='<watch-url>'; while b=$(curl -fsS "$u"); do case $b in *'"result":null'*) sleep 5;; *) break;; esac; done; echo "$b"
```

