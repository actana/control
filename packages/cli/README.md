# @actana/cli

`actana` — drive AI coding agents across your Cores, from the command line.

A **Core** is a machine that runs AI coding sessions. This package is the
client half of the `actana` command: the registry that names the Cores this
machine can reach, and the verbs that talk to one. It is built on
[`@actana/sdk`](https://www.npmjs.com/package/@actana/sdk) and speaks
`core-link` over mutual TLS.

```sh
npm install -g @actana/cli
actana --help
```

Node **22 or newer**. Published with
[provenance](https://docs.npmjs.com/generating-provenance-statements) — every
release is attested to the workflow and the commit that built it.

## One command name, split by noun

```sh
actana core add laptop ~/blob.txt   # register a Core from its blob, or stdin
actana core ls --json               # what this machine knows
actana core use laptop              # point `current` at one
actana core status                  # reach it, and report what it says
```

`session`, `project`, `harness` and `events` are reserved in the command tree
and land later in the phase; they exit with a distinct code and a ticket number
rather than reading as a typo.

**Running a Core is the other half of the name.** `actana daemon`, and the rest
of the machine-side lifecycle, ships with the Core itself and is not in this
package — a program whose whole job is to talk to a Core over a socket should
not carry a daemon's dependency graph.

## A registration blob is a credential

It carries the client certificate and the bearer token for one Core. This CLI
never prints one — not on `--verbose`, not in an error quoting input that
failed to parse. `actana core add` reads it from a file or from stdin and
stores it at mode 0600; a single-Core setup can pass it as `ACTANA_CORE_BLOB`
instead. Everything that prints reduces a blob to its endpoint and label.

## Versioning

One version line across the Core, the Panel, the SDK and this CLI, published on
the same tag that builds the container images. Pre-1.0, **each minor is the
breaking-change unit** — a patch never changes a shape. This package depends on
`@actana/sdk` at exactly its own version.

## License

MIT — see [LICENSE](https://github.com/actana/control/blob/main/LICENSE).
