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
import { pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const bundle = path.join(here, "..", "dist", "actana-cli.mjs");

try {
  await import(pathToFileURL(bundle).href);
} catch (err) {
  if (err && typeof err === "object" && err.code === "ERR_MODULE_NOT_FOUND") {
    // The checkout case, not the installed case: a published tarball ships
    // `dist/`. Say which command builds it rather than printing a resolver
    // stack trace at somebody who has just cloned the repository.
    process.stderr.write(
      "actana: this checkout has no build yet.\n" +
        "  pnpm --filter @actana/cli build\n",
    );
    process.exit(70);
  }
  throw err;
}
