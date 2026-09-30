// The Panel's browser bundle must not contain Node.
//
// Vitest runs under Node, so a browser module that pulls a server-only
// dependency through an import chain passes every other suite and crashes the
// page on load: `@actana/sdk/core` re-exports the Core client and its
// WebSocket and undici transports, and one browser import of that barrel made
// Vite externalize 120 Node modules and the entry chunk throw
// `util.debuglog is not a function` (review of #578, B1).
//
// This builds the Panel with the real Vite config, so it fails in `pnpm test`
// and therefore in CI's Unit Tests, and asserts that nothing was externalized
// for the browser and that no client chunk imports a `node:` module or carries undici.
// Vite writes the externalized warning to stderr, so the build's stdout and
// stderr are read together, and it builds into a temporary directory so a
// developer's `dist` is left alone. Browser code
// takes core-link frames from `@actana/shared/sdk-link-frames`. The proper SDK
// fix is actana/client#13.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const panelDir = path.resolve(import.meta.dirname, "..", "..");
const vite = path.join(panelDir, "node_modules", "vite", "bin", "vite.js");

/** Run a command and return everything it printed: Vite logs warnings to stderr, so stdout alone is not enough. */
export function runCollectingOutput(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function jsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

describe("the output collector", () => {
  it("returns what a command wrote to stderr as well as stdout", () => {
    const { output } = runCollectingOutput(process.execPath, [
      "-e",
      'process.stdout.write("to-stdout"); process.stderr.write("to-stderr")',
    ]);
    expect(output).toContain("to-stdout");
    expect(output).toContain("to-stderr");
  });
});

describe("the Panel client bundle", () => {
  it("externalizes no Node module and carries no server transport", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-bundle-"));
    try {
      const { status, output } = runCollectingOutput(process.execPath, [vite, "build", "--outDir", outDir], {
        cwd: panelDir,
        env: { ...process.env, NODE_ENV: "production", FORCE_COLOR: "0" },
      });
      expect(status, output.slice(-2000)).toBe(0);

      const externalized = output.split("\n").filter((line) => line.includes("externalized for browser compatibility"));
      expect(externalized, externalized.slice(0, 5).join("\n")).toEqual([]);

      const chunks = jsFiles(path.join(outDir, "client"));
      expect(chunks.length, "no client chunks were built into the temporary directory").toBeGreaterThan(0);
      const offenders: string[] = [];
      for (const file of chunks) {
        const text = fs.readFileSync(file, "utf8");
        if (/(?:from|import|require)\s*\(?\s*["']node:[a-z_/]+["']|undici|__vite-browser-external/.test(text)) {
          offenders.push(path.basename(file));
        }
      }
      expect(offenders, "client chunks that import Node-only code").toEqual([]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 180_000);
});
