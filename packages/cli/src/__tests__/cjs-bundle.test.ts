// The CommonJS bundle the Core tarball stages as `app/actana-cli.cjs`, run the way the tarball runs it
// (#580 T-405).
//
// The tarball's tree is `type: commonjs`, so `build.mjs` emits CJS. A published `@actana/cli` that read
// a file through `import.meta.url` at module load (its orchestration skill payload, `../../data/
// orchestration-skill.json`) crashed such a bundle at start-up with `fileURLToPath(undefined)`, before
// any verb ran. The client fixed it (actana/client PR 54) and this package takes the payload from
// `@actana/cli/skill-payload`; this test is what notices the next module that does it again.
//
// It builds with the package's own `build.mjs`, so what runs is what the tarball stages, and runs it
// under plain `node` with no `ACTANA_*` / `AC_*` variable and a throwaway HOME.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = path.resolve(import.meta.dirname, "..", "..");
const BUNDLE = path.join(PACKAGE_DIR, "dist-tarball", "actana-cli.cjs");

let home: string;

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home };
  return env;
}

function runBundle(args: string[]) {
  return spawnSync(process.execPath, [BUNDLE, ...args], { env: cleanEnv(), encoding: "utf8", timeout: 30_000 });
}

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "actana-cjs-bundle-"));
  const build = spawnSync(process.execPath, ["build.mjs"], { cwd: PACKAGE_DIR, env: cleanEnv(), encoding: "utf8", timeout: 120_000 });
  if (build.status !== 0) throw new Error(`build.mjs exited ${build.status}:\n${build.stdout}${build.stderr}`);
}, 150_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the CommonJS bundle the Core tarball stages", () => {
  it("is plain CommonJS with no top-level `import.meta` read", () => {
    const text = readFileSync(BUNDLE, "utf8");
    // esbuild rewrites a surviving `import.meta` to an empty `import_meta` object, whose `.url` is
    // `undefined`; a module that reads it at load is the crash. None may remain in this bundle.
    expect(text).not.toMatch(/\bimport_meta\.url\b/);
  });

  it("starts, and answers --version on stdout with nothing on stderr and exit 0", () => {
    const run = runBundle(["--version"]);
    expect(run.status, `stderr: ${run.stderr}`).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toMatch(/^actana \d+\.\d+\.\d+\S*\n$/);
  });

  it("loads the orchestration skill payload at start-up: `harness skills --json` lists it", () => {
    const run = runBundle(["harness", "skills", "--json"]);
    expect(run.status, `stderr: ${run.stderr}`).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout).skills.length).toBeGreaterThan(0);
  });

  it("refuses an unknown command with exit 2 on stderr, from the same bundle", () => {
    const run = runBundle(["search"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/unknown command "search"/);
  });
});
