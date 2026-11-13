import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EXIT_TASK_FAILED,
  EXIT_TASK_GONE,
  EXIT_TASK_IDLE_NO_RESULT,
  EXIT_TASK_INTERRUPTED,
  EXIT_TASK_NEEDS_INPUT,
  EXIT_TASK_PARTIAL,
  EXIT_TASK_TIMEOUT,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
} from "../exit-codes.ts";
import { runActanaCli, USAGE } from "../actana-cli.ts";
import { runTaskWait, TASK_WAIT_CURL, type TaskWaitPorts } from "../task-wait.ts";
import { fakeSystem, stubClientHalf } from "./machine-fixture.ts";
import type { ActanaCliDeps } from "../cli-deps.ts";

const URL_ = "https://panel.test/api/watch/tok.sig";
const T0 = 1_700_000_000_000;

type Payload = {
  taskId: string;
  attempt: number;
  status: "queued" | "in_progress" | "done" | "failed" | "partial";
  sessionState: "working" | "needs-input" | "interrupted" | "idle-no-result" | "exited" | null;
  sessionStateAt: number | null;
  result: "done" | "failed" | "partial" | null;
  updatedAt: number;
  pollAfterSeconds: number;
};

function payload(over: Partial<Payload> = {}): Payload {
  return {
    taskId: "task-1",
    attempt: 1,
    status: "in_progress",
    sessionState: "working",
    sessionStateAt: T0,
    result: null,
    updatedAt: T0,
    pollAfterSeconds: 5,
    ...over,
  };
}

const json = (p: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(p), { status, headers: { "content-type": "application/json", ...headers } });

/** One scripted answer per call; an Error is a network failure; the last answer repeats. */
type Step = Response | Error;

function harness(steps: Step[], random = () => 0.5) {
  let clock = T0;
  const sleeps: number[] = [];
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let i = 0;
  const ports: TaskWaitPorts = {
    fetch: async (url) => {
      calls.push(String(url));
      const step = steps[Math.min(i++, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return step.clone();
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random,
  };
  const run = (argv: string[]) => runTaskWait(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, ports);
  return { run, sleeps, calls, out, err, elapsed: () => clock - T0 };
}

describe("actana task wait — exit codes", () => {
  const finals: [Payload["status"], number][] = [
    ["done", EXIT_OK],
    ["failed", EXIT_TASK_FAILED],
    ["partial", EXIT_TASK_PARTIAL],
  ];
  for (const [status, code] of finals) {
    it(`a final status ${status} exits ${code}`, async () => {
      const h = harness([json(payload({ status, result: status as "done" | "failed" | "partial", pollAfterSeconds: 0 }))]);
      expect(await h.run([URL_])).toBe(code);
      expect(h.sleeps).toEqual([]);
    });
  }

  const stops: [Payload["sessionState"], number][] = [
    ["needs-input", EXIT_TASK_NEEDS_INPUT],
    ["interrupted", EXIT_TASK_INTERRUPTED],
    ["idle-no-result", EXIT_TASK_IDLE_NO_RESULT],
  ];
  for (const [sessionState, code] of stops) {
    it(`sessionState ${sessionState} stops with ${code}`, async () => {
      const h = harness([json(payload()), json(payload({ sessionState }))]);
      expect(await h.run([URL_])).toBe(code);
      expect(h.calls).toHaveLength(2);
    });
    it(`--until-final ignores ${sessionState} and waits for the final status`, async () => {
      const h = harness([
        json(payload({ sessionState })),
        json(payload({ sessionState })),
        json(payload({ status: "done", result: "done", pollAfterSeconds: 0 })),
      ]);
      expect(await h.run([URL_, "--until-final"])).toBe(EXIT_OK);
      expect(h.calls).toHaveLength(3);
    });
  }

  it("exited is not a stop state: the Panel decides the status, so the loop keeps polling", async () => {
    const h = harness([
      json(payload({ sessionState: "exited" })),
      json(payload({ status: "failed", result: "failed", sessionState: "exited", pollAfterSeconds: 0 })),
    ]);
    expect(await h.run([URL_])).toBe(EXIT_TASK_FAILED);
  });

  it("410 exits 30 and says the URL is gone", async () => {
    const h = harness([json(payload()), new Response("", { status: 410 })]);
    expect(await h.run([URL_])).toBe(EXIT_TASK_GONE);
    expect(h.err.join("\n")).toMatch(/gone/i);
  });

  it("404 is an error at once: a mistyped URL does not retry for ten minutes", async () => {
    const h = harness([new Response("", { status: 404 })]);
    expect(await h.run([URL_])).toBe(EXIT_FAILURE);
    expect(h.calls).toHaveLength(1);
  });

  it("--timeout exits 31 when the Task is still running", async () => {
    const h = harness([json(payload({ pollAfterSeconds: 15 }))], () => 0.5);
    expect(await h.run([URL_, "--timeout", "1"])).toBe(EXIT_TASK_TIMEOUT);
    expect(h.elapsed()).toBe(60_000);
  });
});

describe("actana task wait — pacing", () => {
  it("sleeps pollAfterSeconds, jittered within ±20 %", async () => {
    for (const [rnd, expected] of [
      [0, 12_000],
      [0.5, 15_000],
      [1, 18_000],
    ] as const) {
      const h = harness([json(payload({ pollAfterSeconds: 15 })), json(payload({ status: "done", result: "done" }))], () => rnd);
      await h.run([URL_]);
      expect(h.sleeps).toEqual([expected]);
    }
  });

  it("clamps pollAfterSeconds to 2..60 s before the jitter", async () => {
    const h = harness(
      [
        json(payload({ pollAfterSeconds: 0 })),
        json(payload({ pollAfterSeconds: 1 })),
        json(payload({ pollAfterSeconds: 600 })),
        json(payload({ status: "done", result: "done" })),
      ],
      () => 0.5,
    );
    await h.run([URL_]);
    expect(h.sleeps).toEqual([2_000, 2_000, 60_000]);
  });

  it("every sleep stays within bounds over many random draws", async () => {
    let n = 0;
    const draws = Array.from({ length: 200 }, (_, k) => (k * 37) % 101 / 100);
    const h = harness(
      [...Array.from({ length: 200 }, () => json(payload({ pollAfterSeconds: 7 }))), json(payload({ status: "done", result: "done" }))],
      () => draws[n++ % draws.length]!,
    );
    await h.run([URL_, "--timeout", "10000"]);
    for (const ms of h.sleeps) {
      expect(ms).toBeGreaterThanOrEqual(7_000 * 0.8);
      expect(ms).toBeLessThanOrEqual(7_000 * 1.2);
    }
  });

  it("429 waits Retry-After seconds, then asks again", async () => {
    const h = harness([
      json(payload()),
      new Response("", { status: 429, headers: { "retry-after": "23" } }),
      json(payload({ status: "done", result: "done" })),
    ]);
    expect(await h.run([URL_])).toBe(EXIT_OK);
    expect(h.sleeps[1]).toBe(23_000);
  });

  it("429 without a usable Retry-After falls back to 60 s", async () => {
    const h = harness([new Response("", { status: 429 }), json(payload({ status: "done", result: "done" }))]);
    await h.run([URL_]);
    expect(h.sleeps).toEqual([60_000]);
  });

  it("network errors back off 2, 4, 8 … up to 60 s and then recover", async () => {
    const down = new Error("ECONNRESET");
    const h = harness([...Array.from({ length: 7 }, () => down), json(payload({ status: "done", result: "done" }))], () => 0.5);
    expect(await h.run([URL_])).toBe(EXIT_OK);
    expect(h.sleeps).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it("5xx is treated like a network error", async () => {
    const h = harness([new Response("", { status: 503 }), json(payload({ status: "done", result: "done" }))], () => 0.5);
    expect(await h.run([URL_])).toBe(EXIT_OK);
    expect(h.sleeps).toEqual([2_000]);
  });

  it("gives up after 10 minutes without one good answer", async () => {
    const h = harness([new Error("ECONNREFUSED")], () => 0.5);
    expect(await h.run([URL_, "--timeout", "1000"])).toBe(EXIT_FAILURE);
    expect(h.elapsed()).toBeGreaterThanOrEqual(10 * 60_000);
    expect(h.elapsed()).toBeLessThan(10 * 60_000 + 61_000);
    expect(h.err.join("\n")).toMatch(/10 minutes/);
  });

  it("one good answer restarts the ten-minute clock", async () => {
    const down = new Error("down");
    const steps: Step[] = [
      ...Array.from({ length: 12 }, () => down),
      json(payload({ pollAfterSeconds: 2 })),
      ...Array.from({ length: 12 }, () => down),
      json(payload({ status: "done", result: "done" })),
    ];
    const h = harness(steps, () => 0.5);
    expect(await h.run([URL_, "--timeout", "1000"])).toBe(EXIT_OK);
  });

  it("a timeout cuts the last sleep short instead of overshooting", async () => {
    const h = harness([json(payload({ pollAfterSeconds: 60 }))], () => 1);
    expect(await h.run([URL_, "--timeout", "1"])).toBe(EXIT_TASK_TIMEOUT);
    expect(h.elapsed()).toBe(60_000);
  });
});

describe("actana task wait — output", () => {
  it("writes one stderr line per state change and nothing on stdout", async () => {
    const h = harness([
      json(payload()),
      json(payload()),
      json(payload({ sessionState: "exited" })),
      json(payload({ status: "done", result: "done", sessionState: "exited" })),
    ]);
    await h.run([URL_]);
    expect(h.err).toHaveLength(3);
    expect(h.err[0]).toContain("in_progress");
    expect(h.err[0]).toContain("working");
    expect(h.err[2]).toContain("done");
    expect(h.out).toEqual([]);
  });

  it("--json prints the last answer, one JSON line, on stdout", async () => {
    const last = payload({ status: "failed", result: "failed", pollAfterSeconds: 0 });
    const h = harness([json(payload()), json(last)]);
    expect(await h.run([URL_, "--json"])).toBe(EXIT_TASK_FAILED);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0]!)).toEqual(last);
  });

  it("--json on a stop state prints that answer", async () => {
    const stop = payload({ sessionState: "needs-input" });
    const h = harness([json(stop)]);
    expect(await h.run([URL_, "--json"])).toBe(EXIT_TASK_NEEDS_INPUT);
    expect(JSON.parse(h.out[0]!)).toEqual(stop);
  });

  it("--json on 410 prints the last good answer it had", async () => {
    const seen = payload();
    const h = harness([json(seen), new Response("", { status: 410 })]);
    expect(await h.run([URL_, "--json"])).toBe(EXIT_TASK_GONE);
    expect(JSON.parse(h.out[0]!)).toEqual(seen);
  });

  it("never prints the URL (its token is a credential)", async () => {
    const h = harness([new Response("", { status: 404 })]);
    await h.run([URL_]);
    expect([...h.err, ...h.out].join("\n")).not.toContain("tok.sig");
  });

  it("an answer that is not the watch payload is an error, not a hang", async () => {
    const h = harness([new Response("<html>", { status: 200 })], () => 0.5);
    expect(await h.run([URL_, "--timeout", "1000"])).toBe(EXIT_FAILURE);
  });
});

describe("actana task wait — usage", () => {
  const cases: [string, string[]][] = [
    ["no URL", []],
    ["two URLs", [URL_, URL_]],
    ["a URL that is not http(s)", ["file:///etc/passwd"]],
    ["not a URL", ["nope"]],
    ["--timeout without a number", [URL_, "--timeout", "soon"]],
    ["--timeout of zero", [URL_, "--timeout", "0"]],
    ["an unknown flag", [URL_, "--forever"]],
  ];
  for (const [name, argv] of cases) {
    it(`${name} exits 2 and makes no request`, async () => {
      const h = harness([json(payload())]);
      expect(await h.run(argv)).toBe(EXIT_USAGE);
      expect(h.calls).toEqual([]);
    });
  }

  it("--help prints the help with the curl one-liner and exits 0", async () => {
    const h = harness([]);
    expect(await h.run(["--help"])).toBe(EXIT_OK);
    expect(h.out.join("\n")).toContain(TASK_WAIT_CURL);
  });
});

describe("actana task wait — the real fetch against a real server", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it("reads a final answer from a local HTTP server with no sleep", async () => {
    server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload({ status: "partial", result: "partial", pollAfterSeconds: 0 })));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/watch/x.y`;
    const out: string[] = [];
    const code = await runTaskWait([url, "--json"], { out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(EXIT_TASK_PARTIAL);
    expect(JSON.parse(out[0]!).result).toBe("partial");
  });
});

describe("actana task — wired into the CLI", () => {
  function cliDeps(argv: string[], out: string[], err: string[], taskWait: Partial<TaskWaitPorts>): ActanaCliDeps {
    return {
      argv,
      env: {},
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      system: fakeSystem({}),
      ...stubClientHalf(() => T0),
      taskWait,
    } as unknown as ActanaCliDeps;
  }

  it("`actana task wait <url>` dispatches to the loop and returns its exit code", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runActanaCli(
      cliDeps(["task", "wait", URL_, "--json"], out, err, {
        fetch: async () => json(payload({ status: "failed", result: "failed", pollAfterSeconds: 0 })),
      }),
    );
    expect(code).toBe(EXIT_TASK_FAILED);
    expect(JSON.parse(out[0]!).status).toBe("failed");
  });

  it("`actana task` alone and an unknown verb are usage errors", async () => {
    for (const argv of [["task"], ["task", "poll"]]) {
      const err: string[] = [];
      expect(await runActanaCli(cliDeps(argv, [], err, {}))).toBe(EXIT_USAGE);
      expect(err.join("\n")).toContain("task wait");
    }
  });

  it("USAGE lists the task command and the curl one-liner", () => {
    expect(USAGE).toMatch(/^\s+task\s+`task wait <url>`/m);
    expect(USAGE).toContain(TASK_WAIT_CURL);
  });
});

describe("exit codes — the table is the card's", () => {
  it("has the numbers the card fixes", () => {
    expect([
      EXIT_OK,
      EXIT_TASK_FAILED,
      EXIT_TASK_PARTIAL,
      EXIT_TASK_NEEDS_INPUT,
      EXIT_TASK_INTERRUPTED,
      EXIT_TASK_IDLE_NO_RESULT,
      EXIT_TASK_GONE,
      EXIT_TASK_TIMEOUT,
      EXIT_FAILURE,
      EXIT_USAGE,
    ]).toEqual([0, 10, 11, 20, 21, 22, 30, 31, 1, 2]);
  });
});
