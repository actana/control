// Container mode — the same `actana` binary reading a different world.
//
// In the Core image the image *is* the install (ADR 0016 D13): there is no
// versioned tree, no `current` symlink, no unit file, no lingering and no
// `actana setup`. Every job setup does is already done by something else — the
// image tag is the versioned tree, `ENTRYPOINT` is the unit, `restart:
// unless-stopped` is lingering, `docker compose pull && up -d` is `actana
// update`. So the lifecycle verbs do not degrade here, they refuse and name
// the Docker command that does the same job (D16); a half-working `setup`
// would be a second lifecycle path that nothing supervises.
//
// Detection is the baked `ACTANA_CONTAINER=1` and never `/.dockerenv` (D16).
// The marker is ours: it is set by the image we ship, so it is true exactly
// when this Core arrived as our container. `/.dockerenv` answers a different
// question ("did *some* runtime start this?"), is absent under Podman and
// nerdctl, and is a file anyone can bind-mount into place.
//
// The operator's whole contract is three variables (D15):
//
//   ACTANA_PUBLIC_HOST  required — the address the Panel dials
//   ACTANA_PORT         8443
//   ACTANA_LABEL        the public host
//
// The public host is required and never guessed. On metal `choosePublicHost()`
// picks the first routable IPv4, which is a good guess for a machine and a
// trap for a container: a bare `docker run` has a container-ID hostname, and a
// guessing default would silently change the certificate SAN — and therefore
// every pairing token this Core ever printed — each time the container is
// recreated.
//
// Everything else the image needs (`AC_CORE_REMOTE`, `AC_CORE_LINK_HOST`,
// `AC_USER_DATA_DIR`, `AC_APP_PATH`, `AC_CORE_MATERIAL_FILE`) is baked as a
// private image constant, not offered as a knob.
//
// Pure: env in, values or a sentence out. Nothing here touches the filesystem,
// the network or the process.

/** The marker the image bakes. Set by us, so it means *our* container. */
export const CONTAINER_ENV = "ACTANA_CONTAINER";

/** Required in container mode: the address a Panel dials this Core on. */
export const CONTAINER_PUBLIC_HOST_ENV = "ACTANA_PUBLIC_HOST";

/** The port the daemon listens on, and the port `EXPOSE` names. */
export const CONTAINER_PORT_ENV = "ACTANA_PORT";

/** The alias shown in the Panel. Defaults to the public host. */
export const CONTAINER_LABEL_ENV = "ACTANA_LABEL";

/** The core-link port when `ACTANA_PORT` is unset. */
export const DEFAULT_CONTAINER_PORT = 8443;

/** What the operator's three variables resolve to. */
export type ContainerContract = {
  /** The cert SAN and the pairing token's endpoint host. Never guessed. */
  publicHost: string;
  port: number;
  label: string;
};

/** A contract that could not be read, with the sentence to print. */
export type ContractError = { error: string };

/**
 * Whether this Core is running as our container image.
 *
 * Exactly `1`: the value is ours to set, so anything else is a hand-edited
 * environment rather than the image, and guessing what `true` or `yes` was
 * meant to mean is how a metal Core ends up refusing its own lifecycle verbs.
 */
export function inContainer(env: NodeJS.ProcessEnv): boolean {
  return env[CONTAINER_ENV] === "1";
}

/** Read a var, treating whitespace-only as unset. */
function trimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Resolve the three operator variables, or say what is wrong with them.
 *
 * Returns a `{ error }` rather than throwing because every caller's next move
 * is to print the sentence and exit — the daemon before it boots, `status` and
 * `token` before they claim to know this Core's endpoint.
 */
export function readContainerContract(
  env: NodeJS.ProcessEnv,
): ContainerContract | ContractError {
  const publicHost = trimmed(env, CONTAINER_PUBLIC_HOST_ENV);
  if (!publicHost) {
    return {
      error:
        `${CONTAINER_PUBLIC_HOST_ENV} is not set, and this Core will not guess it. The ` +
        `address a Panel dials is baked into this Core's certificate and into every ` +
        `pairing token it prints, so a guessed one would change each time the container ` +
        `is recreated and break the pairing. Set it to the host or IP your Panel reaches ` +
        `this container on:\n` +
        `  ${CONTAINER_PUBLIC_HOST_ENV}=core1.example.com`,
    };
  }

  const rawPort = trimmed(env, CONTAINER_PORT_ENV);
  let port = DEFAULT_CONTAINER_PORT;
  if (rawPort !== undefined) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      return {
        error:
          `${CONTAINER_PORT_ENV} must be a whole number between 1 and 65535, got ` +
          `${JSON.stringify(env[CONTAINER_PORT_ENV])}.`,
      };
    }
    port = parsed;
  }

  // The label is what the operator sees in their Panel's Core list, and the
  // public host is the one thing they have already had to name — a better
  // default than a container id nobody chose.
  return { publicHost, port, label: trimmed(env, CONTAINER_LABEL_ENV) ?? publicHost };
}

/**
 * The verbs the image owns, and what the operator runs on the host instead.
 *
 * `logs` is here for the same reason as the other six: there is no journal and
 * no unit in the image, so `journalctl --user -u actana-core.service` has
 * nothing to read. `docker logs` reads the daemon's stdout, which is where the
 * container's Core writes.
 */
const DOCKER_EQUIVALENT: Record<string, { why: string; run: string }> = {
  setup: {
    why: "this image is the install — there is no tree to lay down and no unit to write",
    run:
      `set ${CONTAINER_PUBLIC_HOST_ENV} (and optionally ${CONTAINER_PORT_ENV}, ` +
      `${CONTAINER_LABEL_ENV}) in your compose file, then:\n  docker compose up -d`,
  },
  start: { why: "the container runtime starts this Core", run: "docker compose up -d" },
  stop: { why: "the container runtime stops this Core", run: "docker compose stop" },
  restart: { why: "the container runtime restarts this Core", run: "docker compose restart" },
  update: {
    why: "a new Core is a new image, not a tree swapped under a running daemon",
    run: "docker compose pull && docker compose up -d",
  },
  uninstall: {
    why: "removing this Core means removing its container",
    run:
      "docker compose down\nAdd `-v` to also delete this Core's sessions and its pairing " +
      "credentials — that, and only that, unpairs it.",
  },
  logs: {
    why: "the daemon writes to stdout, and there is no journal in the image to read",
    run: "docker compose logs -f",
  },
};

/**
 * The refusal for a verb the image owns, or null when the verb works here.
 *
 * A refusal always names the replacement: "not available" on its own leaves an
 * operator with a Core they cannot restart and no idea what to type.
 */
export function containerRefusal(verb: string): string | null {
  const equivalent = DOCKER_EQUIVALENT[verb];
  if (!equivalent) return null;
  return (
    `\`actana ${verb}\` does not run in a container — ${equivalent.why}.\n` +
    `Run this on the host instead:\n  ${equivalent.run}`
  );
}

/**
 * What replaces `actana update` in a container — the two commands the
 * reference deployment's `deploy/docker-compose.yml` is driven with.
 *
 * The update check's remedy line reads it from here rather than spelling the
 * commands out again, so a container operator is told the same thing whether
 * they typed `actana update` and were refused or read the availability line in
 * `actana status`.
 */
export function containerUpdateCommand(): string {
  return DOCKER_EQUIVALENT.update.run;
}

/** The verbs {@link containerRefusal} answers, in the order help lists them. */
export function refusedContainerVerbs(): string[] {
  return Object.keys(DOCKER_EQUIVALENT);
}
