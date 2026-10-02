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
