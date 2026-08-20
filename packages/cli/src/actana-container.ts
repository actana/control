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

import {
  CONTAINER_LABEL_ENV,
  CONTAINER_PORT_ENV,
  CONTAINER_PUBLIC_HOST_ENV,
  DOCKER_COMPOSE_UPDATE,
} from "@actana/shared/actana-container-contract";

// Re-exported so this stays the one container module the CLI imports. The
// contract half lives in `@actana/shared` because the daemon reads it too
// (#288 D2); what is left here is the refusal table, which is only ever about
// a verb somebody typed.
export {
  CONTAINER_ENV,
  CONTAINER_LABEL_ENV,
  CONTAINER_PORT_ENV,
  CONTAINER_PUBLIC_HOST_ENV,
  DEFAULT_CONTAINER_PORT,
  coreUpdateCommand,
  inContainer,
  readContainerContract,
  type ContainerContract,
  type ContractError,
} from "@actana/shared/actana-container-contract";

/**
 * The verbs the image owns, and what the operator runs on the host instead.
 *
 * `logs` is here for the same reason as the other seven: there is no journal
 * and no unit in the image, so `journalctl --user -u actana-core.service` has
 * nothing to read. `docker logs` reads the daemon's stdout, which is where the
 * container's Core writes.
 *
 * **Only the machine-lifecycle verbs are here, never a client noun.** `core`,
 * `project`, `harness`, `events` and `session` reach a Core over the core link
 * and work identically on metal, in a container and on a laptop with no Core —
 * a Session running on this Core drives Cores with them (#288). The dispatch
 * checks the nouns before it consults this table, and
 * `actana-machine-cli.test.ts` asserts no noun is a key here, so the claim is
 * bound to the table as well as to the dispatch order.
 */
const DOCKER_EQUIVALENT: Record<string, { why: string; run: string }> = {
  // `install` refuses for exactly `setup`'s reason and had to join the table
  // with it (#288 D8): it is the verb that *puts a Core on this machine*, and
  // in the image the machine already is one. Letting it run would download a
  // release and lay a second tree down beside the image's own Core, with a
  // unit nothing in the container supervises — the "half-working setup" this
  // module's header exists to refuse.
  install: {
    why: "this image is the install — there is no release to fetch and no tree to lay down",
    run:
      `set ${CONTAINER_PUBLIC_HOST_ENV} (and optionally ${CONTAINER_PORT_ENV}, ` +
      `${CONTAINER_LABEL_ENV}) in your compose file, then:\n  docker compose up -d`,
  },
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
    run: DOCKER_COMPOSE_UPDATE,
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

/** The verbs {@link containerRefusal} answers, in the order help lists them. */
export function refusedContainerVerbs(): string[] {
  return Object.keys(DOCKER_EQUIVALENT);
}
