// `scripts/lib/no-network-preload.cjs`: the guard the tarball smoke runs the bundled CLI under (#580 T-405).
// A guard that silently let traffic through would make "works offline" a statement about nothing, so
// it is held here: it refuses what leaves the machine, logs each attempt where a smoke can read it,
// and leaves loopback and unix sockets alone.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const preload = path.resolve(import.meta.dirname, "..", "lib", "no-network-preload.cjs");

/** Async on purpose: the loopback test's server lives in this process and must keep answering. */
async function runGuarded(script) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "no-net-")), "attempts.log");
  const child = spawn(process.execPath, ["--require", preload, "-e", script], {
    env: { PATH: process.env.PATH, ACTANA_NO_NETWORK_LOG: log },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const status = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  const attempts = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { status, stdout, stderr, attempts };
}

describe("no-network-preload", () => {
  it("refuses a connection to a public address with ENETUNREACH, and logs the attempt", async () => {
    const run = await runGuarded(`
      const s = require("node:net").connect(443, "192.0.2.1");
      s.on("error", (e) => { console.log("CODE=" + e.code); process.exit(0); });
      s.on("connect", () => { console.log("CONNECTED"); process.exit(3); });
    `);
    expect(run.stdout).toContain("CODE=ENETUNREACH");
    expect(run.attempts).toEqual(["connect 192.0.2.1:443"]);
  });

  it("refuses a name lookup, through callback and promise alike, and logs it", async () => {
    const run = await runGuarded(`
      const dns = require("node:dns");
      dns.lookup("example.invalid", (e) => {
        console.log("CB=" + e.code);
        dns.promises.lookup("example.invalid").catch((e2) => { console.log("PROMISE=" + e2.code); });
      });
    `);
    expect(run.stdout).toContain("CB=ENETUNREACH");
    expect(run.stdout).toContain("PROMISE=ENETUNREACH");
    expect(run.attempts).toEqual(["lookup example.invalid", "lookup example.invalid"]);
  });

  it("refuses global fetch to a remote host, which is how a client would phone home", async () => {
    const run = await runGuarded(`
      fetch("http://192.0.2.1:8080/").then(() => { console.log("FETCHED"); }, (e) => { console.log("FETCH_FAILED"); });
    `);
    expect(run.stdout).toContain("FETCH_FAILED");
    expect(run.attempts.join("\n")).toContain("connect 192.0.2.1:8080");
  });

  it("lets loopback through and logs nothing", async () => {
    const server = net.createServer((c) => c.end("hi"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const run = await runGuarded(`
      const s = require("node:net").connect(${port}, "127.0.0.1");
      s.on("data", (d) => { console.log("GOT=" + d); process.exit(0); });
      s.on("error", (e) => { console.log("ERR=" + e.code); });
    `);
    server.close();
    expect(run.stdout).toContain("GOT=hi");
    expect(run.attempts).toEqual([]);
  });

  it("lets a unix socket path through", async () => {
    const run = await runGuarded(`
      const s = require("node:net").connect("/nonexistent/socket");
      s.on("error", (e) => { console.log("CODE=" + e.code); });
    `);
    expect(run.stdout).toContain("CODE=ENOENT");
    expect(run.attempts).toEqual([]);
  });
});
