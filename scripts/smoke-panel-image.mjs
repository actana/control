#!/usr/bin/env node
// Smoke test — the Panel image is a working one-container deployment.
//
// Builds deploy/panel.Dockerfile against the repo root as build context
// (unless told the image already exists), boots it with a fresh named
// volume, and walks the operator's first day as HTTP calls:
// first boot wants setup, setup creates the Operator, and — after the
// container is destroyed and recreated on the same volume, the upgrade
// motion — the Panel still knows its Operator and accepts the password.
// That is issue 09's acceptance criterion "all persistent state survives
// container recreation via the single volume" stated as a test.
//
// It also inspects the built image's config for the two things a builder can
// silently drop rather than fail on — the HEALTHCHECK and the non-root USER
// (ADR 0016 D21, D23). Booting on a fresh named volume is itself the check
// for D22: Docker seeds the volume from the image's mode at /data, so a
// root-owned /data fails here and nowhere else.
//
// Needs a Docker daemon. Everything it creates (container, volume) carries a
// unique suffix and is removed on exit; the built image is left behind on
// purpose — CI pushes the very bytes that passed.
//
// Usage:
//   node scripts/smoke-panel-image.mjs [--image <tag>] [--skip-build] [--timeout <ms>]
//
// --image <tag>   Image tag to build and/or run (default: actana-panel:smoke)
// --skip-build    Run an already-built image instead of building first
// --timeout <ms>  Per-boot readiness wait (default: 120000 — cold pulls and
//                 first-boot schema creation on a CI runner are slow)

import { spawnSync } from "node:child_process";

import { parseArgs } from "./lib/cli.mjs";
import { makeDie, pickFreePort } from "./lib/core-smoke.mjs";
import {
  PANEL_DOCKERFILE,
  PANEL_NODE_BIN,
  PANEL_PORT,
  PANEL_RUNTIME_USER,
  PANEL_TABLES,
  repoRoot,
} from "./lib/panel-image.mjs";

const die = makeDie("panel-image-smoke");
const log = (message) => console.log(`[panel-image-smoke] ${message}`);

const args = parseArgs(process.argv.slice(2));
const image = typeof args.image === "string" ? args.image : "actana-panel:smoke";
const timeoutMs = Number(args.timeout ?? 120_000);

const suffix = `${process.pid}-${Date.now().toString(36)}`;
const containerName = `actana-panel-smoke-${suffix}`;
const volumeName = `actana-panel-smoke-data-${suffix}`;

const OPERATOR = { name: "Smoke Operator", password: "smoke-operator-passphrase" };

function docker(dockerArgs, { allowFailure = false } = {}) {
  const result = spawnSync("docker", dockerArgs, { encoding: "utf8" });
  if (result.error) die(`docker ${dockerArgs[0]}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    die(`docker ${dockerArgs.join(" ")} exited ${result.status}:\n${result.stderr}`);
  }
  return result;
}

function cleanup() {
  docker(["rm", "-f", containerName], { allowFailure: true });
  docker(["volume", "rm", "-f", volumeName], { allowFailure: true });
}
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(1));
}

function startContainer(hostPort) {
  docker([
    "run",
    "--detach",
    "--name",
    containerName,
    "--publish",
    `127.0.0.1:${hostPort}:${PANEL_PORT}`,
    "--volume",
    `${volumeName}:/data`,
    image,
  ]);
}

function containerLogsTail() {
  const result = docker(["logs", "--tail", "40", containerName], { allowFailure: true });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

async function waitForReady(base) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/healthz`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  die(`Panel not ready within ${timeoutMs}ms. Container logs:\n${containerLogsTail()}`);
}

async function api(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response;
}

async function authState(base) {
  const response = await api(base, "GET", "/api/auth/state");
  if (!response.ok) die(`GET /api/auth/state → ${response.status}`);
  return response.json();
}

// The reference compose file must at least be a compose file: `config`
// resolves the YAML and the env interpolation, which the invariant tests'
// deliberately narrow parser cannot vouch for.
log("validating deploy/docker-compose.yml …");
const composeCheck = spawnSync(
  "docker",
  ["compose", "-f", "deploy/docker-compose.yml", "config", "--quiet"],
  { cwd: repoRoot, encoding: "utf8" },
);
if (composeCheck.status !== 0) {
  die(`docker compose config rejected the reference compose file:\n${composeCheck.stderr}`);
}

if (!args["skip-build"]) {
  log(`building ${image} …`);
  const build = spawnSync("docker", ["build", "--file", PANEL_DOCKERFILE, "--tag", image, "."], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (build.status !== 0) die(`docker build exited ${build.status}`);
}

// HEALTHCHECK is a Docker-schema config field, and a builder is free to drop
// it: podman does exactly that, silently, unless told `--format docker`. So
// the Dockerfile saying so is not evidence — the built bytes are (ADR 0016
// D23). USER rides along for the same reason: it is the whole of D21, and an
// image that lost it would still pass every functional check below as root.
log("verifying the built image carries its healthcheck and drops privilege …");
const config = JSON.parse(
  docker(["image", "inspect", "--format", "{{json .Config}}", image]).stdout,
);
const healthcheckTest = (config?.Healthcheck?.Test ?? []).join(" ");
if (!healthcheckTest.includes(PANEL_NODE_BIN)) {
  die(
    `${image} carries no healthcheck naming ${PANEL_NODE_BIN} — the builder dropped it, ` +
      `or the Dockerfile used the bare "node" form that distroless's PATH cannot find. ` +
      `Config.Healthcheck was ${JSON.stringify(config?.Healthcheck ?? null)}`,
  );
}
if (config?.User !== PANEL_RUNTIME_USER) {
  die(`${image} runs as ${JSON.stringify(config?.User)}, expected ${PANEL_RUNTIME_USER}`);
}

docker(["volume", "create", volumeName]);

// Boot 1: a clean machine. First boot must ask for setup, and setup must
// create the Operator.
const firstPort = await pickFreePort();
const firstBase = `http://127.0.0.1:${firstPort}`;
log(`boot 1 on ${firstBase} — expecting first-boot setup`);
startContainer(firstPort);
await waitForReady(firstBase);

const fresh = await authState(firstBase);
if (fresh.needsSetup !== true) die(`fresh volume reports needsSetup=${fresh.needsSetup}`);

const setup = await api(firstBase, "POST", "/api/auth/setup", OPERATOR);
if (!setup.ok) die(`POST /api/auth/setup → ${setup.status}: ${await setup.text()}`);
log("setup created the Operator");

// better-sqlite3 is a native module compiled in the build stage against a
// different Node and a different glibc from the one it dlopens under. That it
// loads at all is the load-bearing fact behind the distroless runtime (ADR
// 0016 D20, D25), and "the Panel answered /api/healthz" does not prove it —
// the schema is what proves it. Read the migrated database from inside the
// container, through the same better-sqlite3 the Panel just used.
//
// An absolute node: `docker exec` does not go through ENTRYPOINT, and
// /nodejs/bin is not on the image's PATH, so a bare `node` is not found —
// the same trap the healthcheck has.
log("verifying the migrated schema in the volume …");
const tables = docker([
  "exec",
  containerName,
  PANEL_NODE_BIN,
  "-e",
  `const db=require("better-sqlite3")(process.env.AC_PANEL_DATA_DIR+"/panel.db",{readonly:true});` +
    `console.log(db.prepare("select name from sqlite_master where type='table'").all().map(r=>r.name).join(" "))`,
]).stdout.split(/\s+/);
for (const table of PANEL_TABLES) {
  if (!tables.includes(table)) {
    die(`the migrated database has no '${table}' table — found: ${tables.join(", ") || "(none)"}`);
  }
}
log(`better-sqlite3 loaded and migrated ${PANEL_TABLES.join(", ")} into the volume`);

// Recreate: destroy the container (the upgrade motion — the image is
// replaceable), keep the volume (the state is not).
docker(["rm", "-f", containerName]);
const secondPort = await pickFreePort();
const secondBase = `http://127.0.0.1:${secondPort}`;
log(`boot 2 on ${secondBase} — same volume, new container`);
startContainer(secondPort);
await waitForReady(secondBase);

const survived = await authState(secondBase);
if (survived.needsSetup !== false) {
  die(`recreated container lost the Operator (needsSetup=${survived.needsSetup})`);
}

const login = await api(secondBase, "POST", "/api/auth/login", {
  password: OPERATOR.password,
});
if (!login.ok) die(`POST /api/auth/login → ${login.status}: ${await login.text()}`);
if (!login.headers.getSetCookie().some((c) => c.includes("HttpOnly"))) {
  die("login set no HttpOnly session cookie");
}

log("PASS — image boots, sets up, and its state survives container recreation");
process.exit(0);
