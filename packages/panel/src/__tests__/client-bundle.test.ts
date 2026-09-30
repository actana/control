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
// for the browser and that no client chunk carries undici or ws. Browser code
// takes core-link frames from `@actana/shared/sdk-link-frames`. The proper SDK
// fix is actana/client#13.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const panelDir = path.resolve(import.meta.dirname, "..", "..");
const clientAssets = path.join(panelDir, "dist", "client", "assets");
const vite = path.join(panelDir, "node_modules", "vite", "bin", "vite.js");

describe("the Panel client bundle", () => {
  it("externalizes no Node module and carries no server transport", () => {
    const output = execFileSync(process.execPath, [vite, "build"], {
      cwd: panelDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "production", FORCE_COLOR: "0" },
    });

    const externalized = output.split("\n").filter((line) => line.includes("externalized for browser compatibility"));
    expect(externalized, externalized.slice(0, 5).join("\n")).toEqual([]);

    const offenders: string[] = [];
    for (const file of fs.readdirSync(clientAssets)) {
      if (!file.endsWith(".js")) continue;
      const text = fs.readFileSync(path.join(clientAssets, file), "utf8");
      if (/undici|node:(util|net|tls|http|https|stream|zlib)\b|__vite-browser-external/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders, "client chunks that contain Node-only code").toEqual([]);
  }, 180_000);
});
