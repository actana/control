import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as crypto from "node:crypto";

import { POSTGRES_DB, POSTGRES_IMAGE, POSTGRES_USER } from "./postgres-image.mjs";

/**
 * A throwaway Postgres for the scripts that boot a Panel (#567). The Panel
 * refuses to start without `AC_PANEL_DATABASE_URL`, so each smoke that runs one
 * stands a database up beside it, from the same pinned image the reference
 * compose runs.
 *
 * The password is generated per run and lives only in this process and the
 * container's environment; nothing here is committed or logged.
 */

const READY_TIMEOUT_MS = 60_000;

/** `pg` is a Panel dependency; resolve it from there so scripts need no root copy. */
function loadPg() {
  return createRequire(new URL("../../packages/panel/package.json", import.meta.url))("pg");
}

/** Point a connection URL at a different database name on the same server. */
export function urlForDatabase(baseUrl, database) {
  const url = new URL(baseUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/**
 * `args` for a message: the value of every `--env` / `-e` is replaced, because
 * these carry the database password and a failure message lands in the CI log.
 */
export function redactDockerArgs(args) {
  return args.map((arg, i) => {
    const flag = args[i - 1];
    return (flag === "--env" || flag === "-e") && arg.includes("=")
      ? `${arg.slice(0, arg.indexOf("="))}=<redacted>`
      : arg;
  });
}

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) throw new Error(`docker ${args[0]}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `docker ${redactDockerArgs(args).join(" ")} exited ${result.status}:\n${result.stderr}`,
    );
  }
  return result;
}

/**
 * Start Postgres and wait until it accepts connections.
 *
 * With `network`, it joins that Docker network under `name` and publishes
 * nothing, and `url` is reachable from other containers on it. Without, it
 * publishes a free port on 127.0.0.1 and `url` is reachable from this host.
 * `stop()` removes the container, and is synchronous so an `exit` handler can
 * call it.
 */
export async function startPostgres({ name, network = null }) {
  const password = crypto.randomBytes(24).toString("hex");
  const run = [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--env",
    `POSTGRES_USER=${POSTGRES_USER}`,
    "--env",
    `POSTGRES_DB=${POSTGRES_DB}`,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
  ];
  if (network) run.push("--network", network);
  else run.push("--publish", "127.0.0.1::5432");
  run.push(POSTGRES_IMAGE);

  docker(run);
  const stop = () => {
    docker(["rm", "-f", name], { allowFailure: true });
  };

  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const ready = docker(
        ["exec", name, "pg_isready", "-U", POSTGRES_USER, "-d", POSTGRES_DB, "-h", "127.0.0.1"],
        { allowFailure: true },
      );
      if (ready.status === 0) break;
      if (Date.now() > deadline) {
        const logs = docker(["logs", "--tail", "20", name], { allowFailure: true });
        throw new Error(
          `postgres not ready within ${READY_TIMEOUT_MS}ms:\n${logs.stdout}${logs.stderr}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    let host = name;
    let port = 5432;
    if (!network) {
      const mapped = docker(["port", name, "5432/tcp"]).stdout.trim().split("\n")[0];
      host = "127.0.0.1";
      port = Number(mapped.slice(mapped.lastIndexOf(":") + 1));
    }
    return {
      url: `postgres://${POSTGRES_USER}:${password}@${host}:${port}/${POSTGRES_DB}`,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

/**
 * Make sure `AC_PANEL_DATABASE_URL` is set for the Panels this process spawns:
 * keep one the caller already set (a CI service container, a Postgres on a
 * developer machine), or else start a throwaway one. Returns a `stop()`.
 */
export async function ensurePanelDatabase({ name, log }) {
  if (process.env.AC_PANEL_DATABASE_URL?.trim()) {
    log("using the Postgres named by AC_PANEL_DATABASE_URL");
    return () => {};
  }
  log(`starting ${POSTGRES_IMAGE.split("@")[0]} for the Panel …`);
  const { url, stop } = await startPostgres({ name });
  process.env.AC_PANEL_DATABASE_URL = url;
  return stop;
}

/**
 * A fresh database on the server `ensurePanelDatabase` left in
 * `AC_PANEL_DATABASE_URL`. Each e2e phase needs its own: setup expects 200, and
 * a shared database already has an Operator from the phase before.
 *
 * The throwaway server's `stop()` drops every database with the container; on
 * an external URL the database is left behind for a later sweep.
 */
export async function allocatePanelDatabase({ label, log }) {
  const baseUrl = process.env.AC_PANEL_DATABASE_URL?.trim();
  if (!baseUrl) {
    throw new Error("AC_PANEL_DATABASE_URL is not set — call ensurePanelDatabase first");
  }
  const pg = loadPg();
  const name = `ac_e2e_${label}_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = urlForDatabase(baseUrl, name);
  log(`allocated Postgres database ${name} for ${label}`);
  return { url, name };
}

/**
 * Run a query against a Panel database URL and return the rows. Used by the
 * e2e seam to assert secrets at rest without reading a SQLite file.
 */
export async function queryPanelDatabase(databaseUrl, text, params = []) {
  const pg = loadPg();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(text, params);
    return result.rows;
  } finally {
    await client.end();
  }
}
