/**
 * The Postgres image the Panel's deployment and its smoke scripts run, pinned
 * by version and digest (#567). The reference compose file carries the same
 * string; `scripts/__tests__/panel-image.test.mjs` fails if the two drift.
 *
 * postgres:18.6-bookworm was pushed to Docker Hub on 2026-09-19. The digest is
 * the multi-arch index digest, read from registry-1.docker.io.
 */
export const POSTGRES_IMAGE =
  "postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650";

/** The role and database the bundled Postgres creates, and the Panel dials. */
export const POSTGRES_USER = "panel";
export const POSTGRES_DB = "panel";
