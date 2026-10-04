// Test kit for the code that talks to the `core-home-ops` helper (issue 559).
//
// Nothing in a unit test can `setpriv`, so the tests stand in for the helper
// process. Two stand-ins, for two questions:
//
//   - `cannedHelper`: the call site's question. It records each request and
//     answers with something plausible, so a test can assert what the daemon
//     *asked* and that it asked instead of touching the disk itself.
//   - `inProcessHelper`: the helper's real code (request validation, confinement,
//     the operations) run in this process with `home` as the only root, exactly as
//     `core-home-ops-main.ts` runs it in the container.
//
// `core-home-ops-process.test.ts` runs the real bundle as a real child process.

import { Readable } from "node:stream";
import { runCoreHomeOpsMain } from "../core-home-ops-main";
import type { CoreHomeOpRequest } from "../core-home-ops";
import type { CoreHomeOpsOptions, HelperOutcome } from "../core-home-ops-client";

export type RecordedRequest = { request: CoreHomeOpRequest; env: NodeJS.ProcessEnv | undefined; command: string };

function ok(result: unknown): HelperOutcome {
  return { status: 0, stdout: `${JSON.stringify({ ok: true, result })}\n`, stderr: "" };
}

function canned(request: CoreHomeOpRequest): unknown {
  switch (request.op) {
    case "spawnPathFacts":
      return {
        cwdOk: true,
        realpaths: Object.fromEntries([request.cwd, ...request.roots].map((p) => [p, p])),
      };
    case "resolveExecCwd":
      return { cwd: request.cwd ?? "/home/core" };
    case "installHarnessHooks":
      return { installed: true, reportsTurnStart: true, hookTrustBypassEarned: false };
    case "ensureOrchestrationSkill":
      return [];
    case "wireLocalCore":
      return { name: "core-01", selected: true, keptSelection: null };
    case "resolveCommand":
      return { candidates: [`/home/core/.local/bin/${request.command}`] };
    default:
      return null;
  }
}

/** Records every request and answers it with a plausible canned result. */
export function cannedHelper(): { options: CoreHomeOpsOptions; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const answer = (spec: { command: string; env?: NodeJS.ProcessEnv }, input: string): HelperOutcome => {
    const request = JSON.parse(input) as CoreHomeOpRequest;
    requests.push({ request, env: spec.env, command: spec.command });
    return ok(canned(request));
  };
  return {
    requests,
    options: { run: async (spec, input) => answer(spec, input) },
  };
}

/** The helper's real code, confined to `home`, without a process. */
export function inProcessHelper(home: string, extraEnv: NodeJS.ProcessEnv = {}): { options: CoreHomeOpsOptions; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const env = { HOME: home, ...extraEnv };
  return {
    requests,
    options: {
      run: async (spec, input) => {
        requests.push({ request: JSON.parse(input), env: spec.env, command: spec.command });
        let stdout = "";
        let stderr = "";
        const status = await runCoreHomeOpsMain({
          stdin: Readable.from([input]),
          stdout: { write: (c) => (stdout += c) },
          stderr: { write: (c) => (stderr += c) },
          env,
        });
        return { status, stdout, stderr };
      },
    },
  };
}
