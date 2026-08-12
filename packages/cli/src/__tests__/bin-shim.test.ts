// `bin/actana.mjs` — the published path, run as a program.
//
// This is the one file in the package that cannot be renamed without breaking
// every already-installed copy (npm records it when it links the command), and
// it is the only one no other suite touches: every other test drives
// `runActanaCli` in process, which is exactly what makes the shim's two jobs —
// *find the bundle* and *say something true when it is not there* — invisible
// to them. Both were wrong, and both were wrong in a way that only shows up
// when you run the file rather than read it.
//
// So this suite runs it, in a real subprocess, from directories it stages. That
// is not a breach of the "cannot start a process" boundary
// (`no-local-escape.test.ts`, #129 D9): that sweep is over *shipped* modules,
// and it is a test's job to be able to start the program under test. Nothing
// here is imported by anything the tarball carries.
//
// The bundle is stubbed rather than built. What is under test is the shim's
// path arithmetic and its diagnosis, neither of which cares what the bundle
// does — and a suite that needed `pnpm build` to have run first would be a
// suite that gets skipped.

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The real shim, as it sits in the package. */
const SHIM = path.resolve(import.meta.dirname, "..", "..", "bin", "actana.mjs");

const staged: string[] = [];
afterEach(() => {
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A copy of the package layout — `bin/actana.mjs` and optionally
 * `dist/actana-cli.mjs` — under a directory named `dirName`.
 *
 * The name is a parameter because it is the subject: the shim resolves its own
 * location, so what that location is spelled like is the input that broke it.
 */
function stage(dirName: string, bundleSource: string | null): string {
  const root = mkdtempSync(path.join(tmpdir(), "actana-shim-"));
  staged.push(root);
  const pkg = path.join(root, dirName);
  mkdirSync(path.join(pkg, "bin"), { recursive: true });
  copyFileSync(SHIM, path.join(pkg, "bin", "actana.mjs"));
  if (bundleSource !== null) {
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    writeFileSync(path.join(pkg, "dist", "actana-cli.mjs"), bundleSource);
  }
  return path.join(pkg, "bin", "actana.mjs");
}

/** Run a staged shim the way npm's link would. */
function runShim(shim: string): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [shim, "core", "ls"], { encoding: "utf8" });
  return { code: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
}

/** A bundle that proves it was the thing that ran. */
const MARKER = "the-bundle-ran";
const WORKING_BUNDLE = `process.stdout.write(${JSON.stringify(MARKER)});\n`;

describe("bin/actana.mjs finds its bundle", () => {
  it("runs from a path with no space in it", () => {
    // The control. Without it, the test below could pass against a shim that is
    // broken everywhere, and "it works in the plain case" is the claim the
    // percent-encoding bug hid behind.
    const run = runShim(stage("plain", WORKING_BUNDLE));
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(MARKER);
  });

  it("runs from a path containing a space", () => {
    // The reproduction, from the review of #201. `new URL(import.meta.url)
    // .pathname` gives `.../dir with space/bin` back as
    // `.../dir%20with%20space/bin`, so the join names a bundle that is not
    // there and the shim reports an unbuilt checkout — with the build sitting
    // right next to it. On Windows the same expression yields `/C:/Users/...`,
    // and `C:\Users\First Last\` is the *ordinary* install path there, which is
    // why this is the platform's common case rather than an edge one. That half
    // cannot be run on this CI; `fileURLToPath` is what fixes both, and the
    // space is the half a POSIX runner can prove.
    const run = runShim(stage("dir with space", WORKING_BUNDLE));
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(MARKER);
    expect(run.err).not.toContain("no build yet");
  });

  it("resolves its own location with fileURLToPath, not with a URL pathname", () => {
    // The assertion the runner cannot make behaviourally: a drive-lettered
    // `/C:/Users/...` needs Windows to observe, and it is the same bug as the
    // space above. Pinning the identifier keeps the Windows half from
    // regressing silently on a POSIX-only CI.
    const source = readFileSync(SHIM, "utf8");
    expect(source).toContain("fileURLToPath(import.meta.url)");
    expect(source).not.toMatch(/new URL\(\s*import\.meta\.url\s*\)\s*\.pathname/);
  });
});

describe("bin/actana.mjs diagnoses what is actually missing", () => {
  it("names the build command when the bundle is the thing that is not there", () => {
    const run = runShim(stage("plain", null));
    expect(run.code).toBe(70);
    expect(run.err).toContain("this checkout has no build yet");
    expect(run.err).toContain("pnpm --filter @actana/cli build");
  });

  it("does not blame the build for a dependency the built bundle cannot resolve", () => {
    // The state that made the finding above hard to see: `dist/` is built, and
    // `ws` — the SDK's socket library, and this package's only other runtime
    // dependency — is not installed. Keying the diagnosis on
    // `ERR_MODULE_NOT_FOUND` reported that as an unbuilt checkout, which sends
    // the reader to re-run a build that has already succeeded. The error the
    // bundle actually threw has to survive.
    const run = runShim(stage("plain", 'import "ws";\n'));
    expect(run.err).not.toContain("no build yet");
    expect(run.code).not.toBe(70);
    expect(run.err).toContain("ERR_MODULE_NOT_FOUND");
    // Naming the package is the whole difference between the two states.
    expect(run.err).toContain("ws");
  });
});
