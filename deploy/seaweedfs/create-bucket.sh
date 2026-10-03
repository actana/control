#!/bin/sh
# Create the Shared folder's bucket once the S3 gateway answers; idempotent.
#
# Nothing else in the product creates SEAWEEDFS_BUCKET: the Panel holds only the OIDC signing key, and the role a Core
# assumes has no bucket-level action (iam.json.tmpl), so a fresh volume would refuse every Core's read, write and list.
# This runs inside the container, as the one static admin identity the container already holds (the entrypoint's
# AWS_* pair, or the compose variables it was rendered from). It goes nowhere else and widens no policy.
#
#   create-bucket.sh          wait for the gateway, then create the bucket if it is missing (started by entrypoint.sh)
#   create-bucket.sh --check  one HEAD: exit 0 only if the bucket exists (the compose healthcheck)
set -eu

endpoint=http://127.0.0.1:8333
bucket=${SEAWEEDFS_BUCKET:-}
access=${AWS_ACCESS_KEY_ID:-${SEAWEEDFS_S3_ADMIN_ACCESS_KEY:-}}
secret=${AWS_SECRET_ACCESS_KEY:-${SEAWEEDFS_S3_ADMIN_SECRET_KEY:-}}
empty_sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

log() { echo "seaweedfs: bucket: $*" >&2; }
[ -n "$bucket" ] && [ -n "$access" ] && [ -n "$secret" ] || { log "SEAWEEDFS_BUCKET and the admin key are required"; exit 1; }

# s3 METHOD — print the HTTP status ("000" when the gateway is not there yet). The key pair goes to curl on stdin,
# not argv, so it is not in the process list. A HEAD is `--head`: `-X HEAD` makes curl wait for a body that never comes
# and hangs until killed. Every call is bounded by --max-time, well under the healthcheck's 5s timeout.
s3() {
  case "$1" in
    HEAD) method=--head ;;
    *) method="-X $1" ;;
  esac
  # shellcheck disable=SC2086 # $method is one fixed flag, or `-X PUT`
  printf 'user = "%s:%s"\n' "$access" "$secret" |
    curl -sS --max-time 3 -o /dev/null -w '%{http_code}' -K - --aws-sigv4 aws:amz:us-east-1:s3 \
      -H "x-amz-content-sha256: $empty_sha256" $method "$endpoint/$bucket" 2>/dev/null || true
}

if [ "${1:-}" = "--check" ]; then
  [ "$(s3 HEAD)" = 200 ]
  exit
fi

last=000
for _ in $(seq 1 90); do
  last=$(s3 HEAD)
  case "$last" in
    200) log "$bucket exists"; exit 0 ;;
    404)
      # 409 is "already yours": another start won the race.
      put=$(s3 PUT)
      case "$put" in
        200 | 409) log "created $bucket"; exit 0 ;;
        *) last="PUT $put" ;;
      esac
      ;;
  esac
  sleep 2
done
log "could not create $bucket (last answer: $last)"
exit 1
