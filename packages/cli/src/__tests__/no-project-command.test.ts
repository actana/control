// Projects are gone (actana/client#10 part 3, ADR 0041 D1). The `project` noun
// and every project argument must refuse. A 0.5.0 Core answers `projectsList`
// with "unhandled frame type" (actana/control#555 / PR 618), and the image smoke
// fails on exactly that (run 36851520551).

import { describe, it, expect, afterEach, vi } from "vitest";
import { fakeSessionGateway, makeCliFixture, registerCore, type CliFixture } from "./cli-harness.ts";
import { EXIT_USAGE, EXIT_OK } from "../exit-codes.ts";
import { sessionGatewayFor, type SessionRow } from "../session-gateway.ts";
import { CoreSession, type CoreClient } from "@actana/sdk/core";

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

describe("session ls sends no project frame", () => {
  it("the real gateway list() dials sessionsList and sessionRowsList only", async () => {
    const frames: string[] = [];
    const client = {
      sessionsList: async () => {
        frames.push("sessionsList");
        return [{ sessionId: "s1", ptyId: null, status: "ready", updatedAt: 1 }];
      },
      sessionRowsList: async () => {
        frames.push("sessionRowsList");
        return {
          sessions: [
            {
              sessionId: "s1",
              title: "t",
              titleManuallySet: false,
              claudeSessionId: null,
              agent: "claude-code",
              status: "ready",
              pinned: false,
              archived: false,
              icon: null,
              updatedAt: 1,
            },
          ],
          archivedCount: 0,
        };
      },
      projectsList: async () => {
        frames.push("projectsList");
        throw new Error("projectsList must not be dialled");
      },
      close: () => undefined,
    } as unknown as CoreClient;

    const gateway = sessionGatewayFor(client);
    const rows = await gateway.list();
    expect(rows).toEqual([
      expect.objectContaining({ sessionId: "s1", title: "t", harness: "claude-code" }),
    ]);
    expect(rows[0]).not.toHaveProperty("projectId");
    expect(rows[0]).not.toHaveProperty("project");
    expect(frames).toEqual(["sessionsList", "sessionRowsList"]);
  });

  it("the real gateway start() creates the row with no project and spawns with no cwd", async () => {
    const sent: Array<{ type: string; body: Record<string, unknown> }> = [];
    const base: Record<string, unknown> = {
      sessionsMutate: async (mutation: Record<string, unknown>) => {
        sent.push({ type: "sessionsMutate", body: mutation });
        return { sessionId: "s9" };
      },
      projectsList: async () => {
        sent.push({ type: "projectsList", body: {} });
        throw new Error("projectsList must not be dialled");
      },
    };
    // Every other method (the event listeners the latch hangs on) is a no-op.
    const client = new Proxy(base, {
      get: (target, key) => (key in target ? target[key as string] : () => () => undefined),
    }) as unknown as CoreClient;
    // CoreSession.start is the SDK's: it must be handed a Session id and no cwd.
    const start = vi.spyOn(CoreSession, "start").mockResolvedValue({
      sessionId: "s9",
      ptyId: "p9",
      command: "claude",
      reportsTurnStart: true,
      dispose: () => undefined,
      screen: () => "",
    } as never);
    try {
      await sessionGatewayFor(client).start({ harness: "claude-code", prompt: "hi", dangerouslySkipPermissions: false });
    } catch {
      // Whatever `wrap` does with the stub is not the point; what was sent is.
    }
    expect(sent.map((f) => f.type)).toEqual(["sessionsMutate"]);
    expect(sent[0]!.body).toEqual({ op: "create", title: "hi", agent: "claude-code" });
    const opts = start.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.sessionId).toBe("s9");
    expect(opts).not.toHaveProperty("cwd");
    expect(opts).not.toHaveProperty("projectId");
    start.mockRestore();
  });

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
