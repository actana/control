// A throwaway machine to install a Core on.
//
// The installer e2es need something no unit test can stand in for: a real init
// system, a real logind session, a real user with no sudo. This is that
// machine — a privileged systemd container, driven as an operator would drive
// a VM — shared by `e2e-actana-setup-linux.mjs` (the one-liner and the
// lifecycle verbs, issues 02, 03 and 06) and `e2e-actana-harnesses-linux.mjs`
// (issue 05), so the container details are debugged once.
//
// Two details are load-bearing and easy to lose:
//
//   • the operator is reached through `machinectl shell`, not `docker exec`.
//     Only the former creates a logind session, and without one `systemctl
//     --user` and `loginctl enable-linger` behave in ways no operator ever
//     sees;
//   • `machinectl shell` always exits 0 and pipes through a PTY, so every
//     script carries its own exit-status sentinel and its output is de-ANSI'd.
//     Without the sentinel every assertion made through it is vacuous.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** The unprivileged user every e2e installs as. */
export const OPERATOR = "operator";

/** How long systemd gets to reach `running` after the container starts. */
const BOOT_TIMEOUT_MS = 90_000;

/** How long a daemon gets to answer on a published port. */
const LISTEN_TIMEOUT_MS = 60_000;

/** Sentinel carrying the real exit code back out of a `machinectl shell`. */
const RC_SENTINEL = /@@ACTANA_RC=(\d+)@@/;

/** Strip the terminal control sequences `machinectl shell`'s PTY emits. */
const ANSI = new RegExp("\\u001b\\[[0-9;?]*[A-Za-z]", "g");

/**
 * A systemd machine with no sudo on it.
 *
 * `apt-get purge sudo` is the assertion "no sudo used" made structural — a
 * test cannot accidentally pass by escalating. polkitd is what lets the
 * operator enable lingering for their own account without being root; without
 * it logind falls back to "root only" and the linger step could never work the
 * way it does on a real distribution.
 *
 * `packages` adds to that base — issue 03's image needs `curl`, because the
 * one-liner starts with it.
 */
export function systemdDockerfile({ base = "ubuntu:24.04", packages = [] } = {}) {
  const all = [
    "systemd",
    "systemd-sysv",
    "systemd-container",
    "dbus",
    "libpam-systemd",
    "polkitd",
    ...packages,
  ];
  return `FROM ${base}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \\
 && apt-get install -y --no-install-recommends \\
      ${all.join(" ")} \\
 && apt-get purge -y --auto-remove sudo \\
 && rm -rf /var/lib/apt/lists/*
# --gid users: Ubuntu already ships a group called \`operator\`, and useradd
# refuses to create a same-named group over it.
RUN useradd --create-home --shell /bin/bash --gid users ${OPERATOR}
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
`;
}

/** Run a command, returning its captured output without throwing. */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    status: result.error ? 127 : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error?.message || ""),
  };
}

/** A free port on the host, released before docker binds it. */
export async function pickHostPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Poll `check` until it is true, or end the test through `die`. */
export async function until(label, timeoutMs, check, die) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) die(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Wait until a daemon answers on a host-published port. */
export async function waitForPort(port, die, timeoutMs = LISTEN_TIMEOUT_MS) {
  await until(
    `port ${port} to answer`,
    timeoutMs,
    () =>
      new Promise((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        const finish = (ok) => {
          socket.destroy();
          resolve(ok);
        };
        socket.setTimeout(2_000);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
      }),
    die,
  );
}

/**
 * Build the image, start the machine, and hand back a handle for driving it.
 *
 * `hostPort` is published from `containerPort` on loopback, so a test client
 * on the host can dial the Core the way a Panel would. The container is
 * removed when the process exits unless `keep` is set.
 */
export async function startSystemdContainer({
  tag,
  name,
  containerPort,
  hostPort,
  dockerfile = systemdDockerfile(),
  keep = false,
  extraRunArgs = [],
  die,
  log,
}) {
  if (run("docker", ["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    die("docker is not available (is the daemon running?)");
  }

  const must = (command, args, options = {}) => {
    const result = run(command, args, options);
    if (result.status !== 0) {
      die(`${command} ${args.join(" ")} exited ${result.status}`, [result.stdout, result.stderr]);
    }
    return result;
  };

  log("building the systemd image");
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-e2e-image-"));
  fs.writeFileSync(path.join(buildDir, "Dockerfile"), dockerfile);
  must("docker", ["build", "-t", tag, buildDir], { stdio: "inherit" });
  fs.rmSync(buildDir, { recursive: true, force: true });

  const cleanup = () => {
    if (keep) {
      log(`--keep: leaving container ${name} running`);
      return;
    }
    run("docker", ["rm", "-f", name]);
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  log(`starting container ${name} (host port ${hostPort} → ${containerPort})`);
  must("docker", [
    "run",
    "-d",
    "--name",
    name,
    // systemd needs to write its own cgroups; this is the standard
    // systemd-in-Docker arrangement, not a shortcut around the test.
    "--privileged",
    "--cgroupns=host",
    "-v",
    "/sys/fs/cgroup:/sys/fs/cgroup:rw",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/run/lock",
    "-p",
    `127.0.0.1:${hostPort}:${containerPort}`,
    ...extraRunArgs,
    tag,
  ]);

  const waitForBoot = () =>
    until(
      "systemd to finish booting",
      BOOT_TIMEOUT_MS,
      () => {
        const state = run("docker", ["exec", name, "systemctl", "is-system-running", "--wait"]);
        // `degraded` is normal in a container (some units cannot run); what
        // matters is that systemd finished booting rather than still starting.
        return ["running", "degraded"].includes(state.stdout.trim());
      },
      die,
    );

  await waitForBoot();
  log("systemd booted");

  // Prove the claim rather than assume it: nothing in this test can escalate.
  if (run("docker", ["exec", name, "sh", "-c", "command -v sudo"]).status === 0) {
    die("the image has sudo on it — the no-sudo claim would be untestable");
  }

  /**
   * Run a shell script as the operator, through a real login session.
   *
   * See the file header for why this goes through `machinectl shell` and why
   * it carries its own exit-status sentinel.
   */
  const asOperator = (script) => {
    // A newline (not `;`) closes the group — the script may end in a comment or
    // a control structure, and `;` after either is a bash syntax error.
    const wrapped = `{ ${script}\n}\nprintf '@@ACTANA_RC=%d@@\\n' "$?"\n`;
    const result = run("docker", [
      "exec",
      name,
      "machinectl",
      "shell",
      "--quiet",
      `${OPERATOR}@`,
      "/bin/bash",
      "-lc",
      wrapped,
    ]);
    if (result.status !== 0) {
      die(`machinectl shell could not run as ${OPERATOR}`, [result.stdout, result.stderr]);
    }

    const clean = result.stdout.replace(ANSI, "");
    const match = RC_SENTINEL.exec(clean);
    if (!match) die("no exit-status sentinel in the session output", clean.split("\n"));
    return {
      status: Number(match[1]),
      stdout: clean.replace(RC_SENTINEL, "").trimEnd(),
      stderr: result.stderr,
    };
  };

  const mustAsOperator = (script) => {
    const result = asOperator(script);
    if (result.status !== 0) {
      die(`operator script failed (${result.status}): ${script}`, [result.stdout, result.stderr]);
    }
    return result;
  };

  return {
    name,
    must,
    asOperator,
    mustAsOperator,
    /** Copy a host file into the operator's home, owned by them. */
    copyToOperator: (source) => {
      const base = path.basename(source);
      must("docker", ["cp", source, `${name}:/home/${OPERATOR}/${base}`]);
      must("docker", ["exec", name, "chown", OPERATOR, `/home/${OPERATOR}/${base}`]);
      return `/home/${OPERATOR}/${base}`;
    },
    /** Reboot the machine and wait for systemd to come back up. */
    reboot: async () => {
      must("docker", ["restart", name]);
      await waitForBoot();
    },
  };
}
