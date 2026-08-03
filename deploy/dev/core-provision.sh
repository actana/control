#!/usr/bin/env bash
# First-boot Harness install for the dev Core-in-a-box (see the unit file for
# why this goes through machinectl). Leaves two files in the operator's home:
#   setup-output.txt        everything `actana setup` printed
#   registration-blob.txt   just the blob, ready to paste into "Add Core"
set -euo pipefail

# logind can lag multi-user.target by a moment; machinectl needs it.
for _ in $(seq 1 30); do
  machinectl shell --quiet operator@ /bin/true >/dev/null 2>&1 && break
  sleep 1
done

# --public-host core: the cert SAN and the blob's endpoint must be the compose
# service name, because that is the address the Panel container dials.
# --no-agents: vendor CLI installers need the network and logins; a dev
# fixture should come up hermetically. Install agents later with
#   docker compose exec core machinectl shell operator@ /bin/bash -lc 'actana setup'
machinectl shell --quiet operator@ /bin/bash -lc '
  set -euo pipefail
  cd ~
  tarball=$(ls -t /opt/harness/actana-harness-*.tar.gz | head -1)
  tar -xzf "$tarball"
  dir=$(basename "$tarball" .tar.gz)
  "./$dir/bin/actana" setup --public-host core --yes --no-agents 2>&1 | tee setup-output.txt
  # The blob is the one long base64 line of the output (same structural
  # extraction as scripts/lib/harness-smoke.mjs).
  grep -E "^[A-Za-z0-9+/=]{100,}$" setup-output.txt | tail -1 > registration-blob.txt
  test -s registration-blob.txt
'

touch /home/operator/.harness-provisioned
