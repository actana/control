// The third boundary: **plain `node` has to be able to load this package.**
//
// Inside the workspace the SDK is consumed as TypeScript source, and its
// relative imports carry `.ts` so that `node script.mjs` resolves them through
// Node's own type stripping with no bundler and no loader. `tsconfig.build.json`
// says so at length, `examples/*.mjs` depend on it, and issue 155's "a plain
// Node script" is literally that.
//
// Type stripping is not `tsc`. It removes annotations and refuses anything that
// would need code *generated* for it — and the trap is that `tsc --noEmit`,
// `vitest` and `eslint` are all perfectly happy with the constructs it rejects,
// so nothing else in this repository notices. This suite found one for real:
// a `constructor(readonly reason: string)` parameter property, which typechecks
// and passes every other test in this directory while making the package
// unloadable by the example scripts beside it.
//
// Enums, namespaces, decorators and `export =` are the other members of that
// family. The check is a real `node` process rather than a regex, so it catches
// whichever of them somebody reaches for next.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SRC = path.resolve(import.meta.dirname, "..");

/** Every shipped module — the same set `package-boundaries.test.ts` sweeps. */
function shippedSources(dir: string = SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...shippedSources(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("plain `node`, no bundler and no loader", () => {
  it("loads every shipped module", () => {
    const modules = shippedSources();
    expect(modules.length).toBeGreaterThan(0);

    // One process importing all of them: a failure names the offending file in
    // its stack, and the whole set costs one spawn rather than a dozen.
    const script = modules
      .map((file) => `await import(${JSON.stringify(pathToFileURL(file).href)});`)
      .join("\n");

    // Throws with the child's stderr attached when the load fails, which is
    // where the `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` and its file live.
    const loaded = (): string =>
      execFileSync(process.execPath, ["--input-type=module", "-e", `${script}\nconsole.log("ok");`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

    expect(loaded().trim()).toBe("ok");
  }, 60_000);

  it("runs an example script far enough to prove the entry points resolve", () => {
    // The examples are the promise this boundary exists for. Run with no
    // configuration, `project-files.mjs` must fail on its *own* missing
    // environment variable — which means every import above it resolved, the
    // types were stripped, and `@actana/sdk/core-client` was reachable by the
    // published specifier. A module-resolution or syntax failure looks entirely
    // different and does not reach this message.
    const example = path.resolve(SRC, "..", "examples", "project-files.mjs");
    let stderr = "";
    try {
      execFileSync(process.execPath, [example], {
        encoding: "utf8",
        env: { ...process.env, ACTANA_CORE_BLOB: "", ACTANA_PROJECT_ID: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      throw new Error("the example should have refused to run without a blob");
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr ?? "");
    }

    expect(stderr).toMatch(/ACTANA_(CORE_BLOB|PROJECT_ID)/);
    expect(stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  }, 60_000);
});
