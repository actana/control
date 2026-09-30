#!/bin/sh
# Render iam.json.tmpl from the environment, then hand over to the image's own
# entrypoint (which drops to the `seaweed` user).
#
# Why a render step and not a static file: the STS signing key is a secret and
# the OIDC issuer / JWKS URL are the Panel's address, so none of them can be
# committed. SeaweedFS does not expand environment variables in its IAM config.
#
# Fail closed: an empty required value, or one still holding a placeholder,
# stops the container instead of starting an S3 gateway that trusts nothing (or
# worse, the wrong thing).
set -eu

TEMPLATE=/seaweedfs-config/iam.json.tmpl
OUT_DIR=/run/seaweedfs
OUT="$OUT_DIR/iam.json"

die() {
  echo "seaweedfs: $*" >&2
  exit 1
}

need() {
  # need NAME — the variable must be set, non-empty and not a placeholder.
  eval "value=\${$1:-}"
  [ -n "$value" ] || die "$1 is required (see deploy/.env.example)"
  case "$value" in
    *change-me* | *CHANGE_ME* | *'<'*'>'*) die "$1 still holds a placeholder" ;;
  esac
  # Values are substituted into JSON with sed: refuse characters that would
  # break out of the string or the sed expression.
  case "$value" in
    *'|'* | *'&'* | *'\'* | *'"'* | *'
'*) die "$1 contains a character that is not allowed here (| & \\ \" or newline)" ;;
  esac
}

need SEAWEEDFS_S3_ADMIN_ACCESS_KEY
need SEAWEEDFS_S3_ADMIN_SECRET_KEY
need SEAWEEDFS_STS_SIGNING_KEY
need SEAWEEDFS_OIDC_ISSUER
need SEAWEEDFS_OIDC_JWKS_URL
need SEAWEEDFS_OIDC_AUDIENCE
need SEAWEEDFS_BUCKET
need SEAWEEDFS_PREFIX

# The signing key is base64 of at least 32 bytes (SeaweedFS refuses shorter).
case "$SEAWEEDFS_STS_SIGNING_KEY" in
  *[!A-Za-z0-9+/=]*) die "SEAWEEDFS_STS_SIGNING_KEY must be base64 (openssl rand -base64 32)" ;;
esac
[ "${#SEAWEEDFS_STS_SIGNING_KEY}" -ge 44 ] ||
  die "SEAWEEDFS_STS_SIGNING_KEY must be base64 of at least 32 bytes (openssl rand -base64 32)"

# The prefix is a path inside the bucket: no leading or trailing slash, no
# wildcard, no dot segments — it is spliced into the policy's Resource.
case "$SEAWEEDFS_PREFIX" in
  /* | */ | *'*'* | *'?'* | *..* | *//*) die "SEAWEEDFS_PREFIX must be a plain path like 'cores'" ;;
esac
case "$SEAWEEDFS_BUCKET" in
  *[!a-z0-9.-]*) die "SEAWEEDFS_BUCKET must be lowercase letters, digits, dots and dashes" ;;
esac

umask 077
mkdir -p "$OUT_DIR"
sed \
  -e "s|@@STS_SIGNING_KEY@@|$SEAWEEDFS_STS_SIGNING_KEY|g" \
  -e "s|@@OIDC_ISSUER@@|$SEAWEEDFS_OIDC_ISSUER|g" \
  -e "s|@@OIDC_JWKS_URL@@|$SEAWEEDFS_OIDC_JWKS_URL|g" \
  -e "s|@@OIDC_AUDIENCE@@|$SEAWEEDFS_OIDC_AUDIENCE|g" \
  -e "s|@@BUCKET@@|$SEAWEEDFS_BUCKET|g" \
  -e "s|@@PREFIX@@|$SEAWEEDFS_PREFIX|g" \
  "$TEMPLATE" >"$OUT"
! grep -q '@@' "$OUT" || die "unrendered placeholder left in $OUT"
chown -R seaweed:seaweed "$OUT_DIR"

# SeaweedFS's gRPC services take no authentication unless a filer signing key
# is set, and the S3 gateway's gRPC port (18333, which can rewrite identities
# and policies) shares the gateway's bind address, which has to be reachable
# from the Cores. A key generated here, per start and never written down, makes
# those calls require a signed token that only this process can mint.
WEED_JWT_FILER_SIGNING_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
[ "${#WEED_JWT_FILER_SIGNING_KEY}" -eq 64 ] || die "could not generate the filer JWT key"
export WEED_JWT_FILER_SIGNING_KEY

# The one static credential: the Panel's key issuer uses it to create the
# bucket and to manage this deployment. Cores never see it.
export AWS_ACCESS_KEY_ID="$SEAWEEDFS_S3_ADMIN_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$SEAWEEDFS_S3_ADMIN_SECRET_KEY"
unset SEAWEEDFS_S3_ADMIN_ACCESS_KEY SEAWEEDFS_S3_ADMIN_SECRET_KEY SEAWEEDFS_STS_SIGNING_KEY

exec /entrypoint.sh "$@"
