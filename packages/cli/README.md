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

```sh
actana project ls                   # the Projects that Core owns
actana project files api            # what is inside one
actana project cp ./dist api:build  # copy a folder into it — and the reverse
actana session start api "fix CI"   # run a harness on it
actana events tail                  # follow what happens
```

Every noun and verb in the tree is built. A name this CLI does not know is a
typo and says so; a name reserved for a later train would exit with a distinct
code and a ticket number instead, which is how the two are told apart.

## Copying files, in either direction

One side carries the Project and the other is on this machine — the `scp` shape.

```sh
actana project cp ./dist api:build     # up:   build becomes a copy of dist
actana project cp api:build ./dist     # down: dist becomes a copy of build
actana project files api:build --json  # what is in there, machine-readable
```

A folder crosses as one streamed archive and keeps its permissions, so an
executable arrives executable. Every file that replaced one already there is
named in the output — never only counted — and `--json` lists them under
`overwritten`, on the failure document as well as the success one: a transfer
that died part-way still replaced whatever it had already written, and that is
the list you need most. Progress appears on a terminal and never under `--json`,
where stdout carries exactly one document.

`project files --json` emits `{entries, truncated}` rather than the bare array
`project ls` emits, because `--limit` can clip the answer and `truncated` is how
a script finds out. It is `false` on a complete listing, never absent.

A local path is told apart from `<project>:<path>` by a rule rather than a
guess: a separator before the colon means local, so `./notes:draft.md` and
`C:\dist` are files on this machine, and that leading `./` is how you name any
local file with a colon in it. The one form this costs is a Windows
*drive-relative* path — `C:dist`, meaning "the current directory on drive C" —
which reads as a Project called `C`; `./C:dist` is the escape, the same one a
filename with a colon in it uses.

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
