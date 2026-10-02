// The daemon's other core-home sites, in container mode (issue 559, PR 3): the
// self-registration blob, the orchestration skill install and `core exec`'s cwd.
// Each one is a request to the helper, and the daemon writes and stats nothing
// under core's home itself.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import log from "@actana/shared/log";
import { verifyBearer } from "@actana/shared/core-link-bearer";
import { decodeRegistrationBlob } from "@actana/shared/registration-blob";
import { registerSelfWithLocalCli } from "../core-self-register";
import {
  configureCoreHomeOps,
  ensureOrchestrationSkillViaCore,
  resolveCommandViaCore,
} from "../core-home-ops-client";
import { runCoreExec } from "../core-exec";
import { cannedHelper, inProcessHelper } from "./core-home-ops-kit";

let base: string;
let daemonHome: string;
let coreHome: string;

function inContainer() {
  vi.stubEnv("AC_CORE_HOME", coreHome);
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
  vi.stubEnv("HOME", daemonHome);
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daemon-sites-")));
  daemonHome = path.join(base, "daemon");
  coreHome = path.join(base, "core");
  fs.mkdirSync(daemonHome);
  fs.mkdirSync(coreHome);
});
afterEach(() => {
  configureCoreHomeOps(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

const material = {
  caCert: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
  clientCert: "-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----",
  clientKey: "-----BEGIN PRIVATE KEY-----\nCLIENTKEY\n-----END PRIVATE KEY-----",
  bearerSecret: "deadbeef".repeat(8),
  coreId: "core_abcdef0123456789",
};
const register = () =>
  registerSelfWithLocalCli({ material, bindHost: "0.0.0.0", port: 8443, label: "core-01", bearerDays: 365, env: {}, home: coreHome });

describe("self-registration", () => {
  it("asks core to write the registry, with a finished credential and never the bearer secret", async () => {
    inContainer();
    const helper = cannedHelper();
    configureCoreHomeOps(helper.options);
    const result = await register();
    expect(result.ok).toBe(true);

    expect(helper.requests.map((r) => r.request.op)).toEqual(["wireLocalCore"]);
    const request = helper.requests[0]!.request as { credential: Record<string, string> };
    expect(request.credential.endpoint).toBe("wss://127.0.0.1:8443");
    expect(Object.keys(request.credential).sort()).toEqual(["bearer", "caCert", "clientCert", "clientKey", "endpoint", "label"]);
    // The bearer is signed by the daemon; the secret that signs it never leaves.
    expect(verifyBearer(request.credential.bearer, material.bearerSecret as never)).toMatchObject({ ok: true });
    expect(JSON.stringify(helper.requests[0])).not.toContain(material.bearerSecret);
    // And the daemon wrote no registry anywhere itself.
    expect(fs.existsSync(path.join(coreHome, ".config"))).toBe(false);
    expect(fs.existsSync(path.join(daemonHome, ".config"))).toBe(false);
  });

  it("lands the blob in core's home when the helper does its work, and the CLI can use it", async () => {
    inContainer();
    configureCoreHomeOps(inProcessHelper(coreHome).options);
    const result = await register();
    expect(result.ok).toBe(true);
    const blob = fs.readFileSync(path.join(coreHome, ".config/actana/cores/core-01.txt"), "utf8");
    expect(decodeRegistrationBlob(blob.trim())).toMatchObject({ endpoint: "wss://127.0.0.1:8443", clientKey: material.clientKey });
    expect(fs.existsSync(path.join(daemonHome, ".config"))).toBe(false);
  });

  it("reports a helper that refused as ok: false, and never throws", async () => {
    inContainer();
    configureCoreHomeOps({
      run: async () => ({ status: 2, stdout: JSON.stringify({ ok: false, code: "path-escape", message: "registry escapes" }), stderr: "" }),
    });
    await expect(register()).resolves.toEqual({ ok: false, error: "registry escapes" });
  });
});

describe("the orchestration skill", () => {
  it("is a request to the helper, and its entries are logged by the daemon", async () => {
    inContainer();
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const entries = [{ harness: "claude-code", outcome: "written", path: "/home/core/.claude/skills/actana-sessions" }];
    const requests: string[] = [];
    configureCoreHomeOps({
      run: async (_spec, input) => (requests.push(input), { status: 0, stdout: JSON.stringify({ ok: true, result: entries }), stderr: "" }),
    });
    await expect(ensureOrchestrationSkillViaCore()).resolves.toEqual(entries);
    expect(requests.map((r) => JSON.parse(r))).toEqual([{ op: "ensureOrchestrationSkill" }]);
    expect(info).toHaveBeenCalledWith("core-skill.written", { harness: "claude-code", path: "/home/core/.claude/skills/actana-sessions" });
    expect(fs.readdirSync(coreHome)).toEqual([]);
  });

  it("is best-effort: a helper that could not run is one warning and no entries", async () => {
    inContainer();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    configureCoreHomeOps({ run: async () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn EACCES") }) });
    await expect(ensureOrchestrationSkillViaCore()).resolves.toEqual([]);
    expect(warn.mock.calls.map((c) => c[0])).toContain("core-skill.install-failed");
  });
});

describe("core exec's cwd", () => {
  it("is checked by core: a missing directory comes back in the operator's sentence, and nothing is spawned", async () => {
    inContainer();
    configureCoreHomeOps(inProcessHelper(coreHome).options);
    const missing = path.join(coreHome, "nope");
    await expect(runCoreExec({ command: "pwd", args: [], cwd: missing })).rejects.toThrow(`No such directory on this Core: ${missing}`);
  });

  it("refuses a cwd outside core's home, from the helper, before any spawn", async () => {
    inContainer();
    configureCoreHomeOps(inProcessHelper(coreHome).options);
    await expect(runCoreExec({ command: "pwd", args: [], cwd: base })).rejects.toThrow(/Not inside this Core's home/);
  });

  it("asks the helper, not fs, for a blank cwd too, and passes its verdict on as it came", async () => {
    inContainer();
    const requests: unknown[] = [];
    configureCoreHomeOps({
      run: async (_spec, input) => {
        requests.push(JSON.parse(input));
        return { status: 1, stdout: JSON.stringify({ ok: false, code: "failed", message: "No such directory on this Core: /home/core" }), stderr: "" };
      },
    });
    await expect(runCoreExec({ command: "pwd", args: [], cwd: "  " })).rejects.toThrow("No such directory on this Core: /home/core");
    expect(requests).toEqual([{ op: "resolveExecCwd", cwd: null }]);
  });
});

describe("resolving a Harness CLI", () => {
  it("is a request to the helper in the container, carrying the PATH to search", async () => {
    inContainer();
    const helper = cannedHelper();
    configureCoreHomeOps(helper.options);
    await expect(resolveCommandViaCore("claude", "/home/core/.local/bin:/usr/bin")).resolves.toEqual(["/home/core/.local/bin/claude"]);
    expect(helper.requests.map((r) => r.request)).toEqual([{ op: "resolveCommand", command: "claude", path: "/home/core/.local/bin:/usr/bin" }]);
  });

  it("finds a CLI core installed in a place the daemon cannot read, through the real helper code", async () => {
    inContainer();
    const bin = path.join(coreHome, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    configureCoreHomeOps(inProcessHelper(coreHome, { PATH: "/usr/bin" }).options);
    await expect(resolveCommandViaCore("claude", `${bin}:/usr/bin`)).resolves.toEqual([path.join(bin, "claude")]);
    await expect(resolveCommandViaCore("codex", `${bin}:/usr/bin`)).resolves.toEqual([]);
  });

  it("reads a malformed answer as finding nothing, not as a TypeError", async () => {
    inContainer();
    for (const result of [{}, { candidates: "/usr/bin/claude" }, { candidates: [1, null, ""] }, null]) {
      configureCoreHomeOps({ run: async () => ({ status: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" }) });
      await expect(resolveCommandViaCore("claude", null)).resolves.toEqual([]);
    }
  });

  it("refuses a command that is not a bare name, before any process", async () => {
    inContainer();
    const helper = cannedHelper();
    configureCoreHomeOps(helper.options);
    await expect(resolveCommandViaCore("/tmp/evil", null)).rejects.toThrow();
    expect(helper.requests).toEqual([]);
  });
});
