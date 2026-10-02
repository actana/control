// Projects are gone (actana/client#10 part 3, ADR 0041 D1). The `project` noun
// and every project argument must refuse. A 0.5.0 Core answers `projectsList`
// with "unhandled frame type" (actana/control#555 / PR 618), and the image smoke
// fails on exactly that (run 36851520551).

import { describe, it, expect, afterEach } from "vitest";
import { fakeSessionGateway, makeCliFixture, registerCore, type CliFixture } from "./cli-harness.ts";
import { EXIT_USAGE, EXIT_OK } from "../exit-codes.ts";
import type { SessionRow } from "@actana/cli";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describe("actana project is gone", () => {
  it("treats `project` as an unknown command (empty stdout, usage on stderr, EXIT_USAGE)", async () => {
    const run = await cli().run(["project", "ls"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.out.join("\n")).toBe("");
    expect(run.err.join("\n")).toMatch(/unknown command ["']project["']/i);
  });

  it("refuses `--cwd` on session start (EXIT_USAGE on stderr, empty stdout)", async () => {
    registerCore(cli().paths, "prod");
    const run = await cli().run(["session", "start", "--cwd", "/tmp", "hello"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.out.join("\n")).toBe("");
    expect(run.err.join("\n")).toMatch(/--cwd/i);
  });
});

// The two gateway-level tests that stood here — the real `list()` dials `sessionsList` and
// `sessionRowsList` only, and the real `start()` creates the row with no project and spawns with no cwd
// (actana/control#555) — drove `sessionGatewayFor(client)` with a stubbed client. That function left
// with the gateway when it moved behind `@actana/cli` (#580), and the package root exports no way to
// hand its gateway a client. What stays is the verb-level test below.
describe("session ls sends no project frame", () => {
  it("actana session ls --json never mentions a project on stdout", async () => {
    registerCore(cli().paths, "prod");
    const row: SessionRow = {
      sessionId: "s1",
      title: "hello",
      harness: "claude-code",
      status: "ready",
      ptyId: null,
      live: false,
      writable: null,
      lock: null,
      updatedAt: 1,
    };
    const run = await cli().run(["session", "ls", "--json"], {
      sessions: fakeSessionGateway({ list: async () => [row] }),
    });
    expect(run.code).toBe(EXIT_OK);
    const payload = run.out.join("\n");
    expect(payload).not.toMatch(/project/i);
    expect(JSON.parse(payload)).toEqual([expect.objectContaining({ sessionId: "s1" })]);
  });
});
