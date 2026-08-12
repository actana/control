#!/usr/bin/env node
/**
 * `actana` — the command name, and the whole reason this file exists.
 *
 * The package is `@actana/cli`; the program it installs is `actana`. That is
 * the `bin` mapping in `package.json`, the same arrangement `node`, `npm` and
 * `claude` ship under, and it is what makes #129 D8 — *one verb, split by
 * noun* — true across two packages: the Core's tarball puts an `actana` on the
 * machine that owns a Core (`setup`, `status`, `daemon`), and `npm i -g
 * @actana/cli` puts an `actana` on a machine that only talks to one. Neither
 * is `actana-cli`, and neither is a second command name to remember.
 *
 * This file stays a shim on purpose. It is the path npm records when it links
 * the command, so it is the one path here that cannot be renamed without
 * breaking every installed copy; the bundle it loads is free to move.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

// `fileURLToPath`, never `new URL(…).pathname`. A URL's pathname is
// percent-encoded and keeps its leading slash, so the one thing this file has
// to get right — where it is — comes out wrong exactly where it matters most:
// `C:\Users\First Last\…` is the ordinary install path on Windows, not an
// exotic one, and `.../dir with space/bin` arrives as `.../dir%20with%20space/bin`.
// The join below would then name a bundle that does not exist, and the check
// after it would blame the build for a path bug.
const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, "..", "dist", "actana-cli.mjs");

// Gate on the bundle itself, not on the error the import throws.
//
// A missing `dist/` is the checkout case, not the installed case — a published
// tarball ships one — and naming the command that builds it beats a resolver
// stack trace at somebody who has just cloned the repository. But that advice
// is only *true* when the bundle is what is missing. Keying on
// `ERR_MODULE_NOT_FOUND` around the import instead swept up every dependency
// the bundle itself fails to resolve — a missing `ws` was reported as an
// unbuilt checkout, sending the reader to run a build that had already run.
// Asking the filesystem one question first cannot make that mistake, and
// anything else the bundle throws now reaches the operator with its own message.
if (!existsSync(bundle)) {
  process.stderr.write(
    "actana: this checkout has no build yet.\n" +
      "  pnpm --filter @actana/cli build\n",
  );
  process.exit(70);
}

await import(pathToFileURL(bundle).href);
