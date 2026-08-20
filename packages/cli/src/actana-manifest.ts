// `core-manifest.json` — what an extracted tarball says it is.
//
// The reader lives in `@actana/shared/actana-manifest` and is re-exported here
// so this stays the one manifest module the CLI imports — the same arrangement
// `actana-release.ts` already uses for the release channel.
//
// It is shared rather than the CLI's own because both halves read a manifest,
// and they read *different* ones: the operator verbs read the install's, to
// act on the version that is actually on the machine (#288 D10 — no pinning,
// tolerate and report), and the daemon reads its own beside its bundle, to
// know what version to compare the release channel against. One reader, two
// roots.

export { readCoreManifest, type CoreManifest } from "@actana/shared/actana-manifest";
