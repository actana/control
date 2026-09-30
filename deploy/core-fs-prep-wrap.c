/*
 * setuid-root wrapper that runs core-fs-prep.sh with real+effective uid 0.
 *
 * The image USER is `core`, so the entrypoint cannot start as root. Compose
 * must not set `user: "0"` either: that would make `docker compose exec`
 * default to root. This binary is the only escalation path, and it only execs
 * the fixed prep script (root:root, not writable by core).
 */
#include <stdio.h>
#include <unistd.h>

#define PREP_SCRIPT "/usr/local/libexec/core-fs-prep.sh"

int main(void) {
  if (setgid(0) != 0) {
    perror("core-fs-prep-wrap: setgid");
    return 1;
  }
  if (setuid(0) != 0) {
    perror("core-fs-prep-wrap: setuid");
    return 1;
  }
  execl(PREP_SCRIPT, PREP_SCRIPT, (char *)NULL);
  perror("core-fs-prep-wrap: execl");
  return 1;
}
