#!/bin/sh
# actana — install the Core bundle and the CLI on this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash
#   actana setup
#
# **Two commands, because installing is not activating** (ADR 0036 C2). This
# script detects the platform, resolves the release, downloads the matching
# tarball, verifies it against the release's published SHA256SUMS, extracts it,
# places the bundle, links the launcher, prints the `actana setup` line to run
# next, and exits. It does not turn this machine into a Core: the mTLS
# material, the systemd unit or LaunchAgent, lingering, the Harness offers, the
# daemon and this machine's own registration are all `actana setup`, which the
# operator runs afterwards. There is no flag for this — it is what the script
# does.
#
# **It does not know the install layout, and must not learn it.** Placement is
# `"$extracted/bin/actana" place` — the CLI in the tree that was just verified,
# running on the Node pinned inside it. ACTANA_HOME, ACTANA_CONFIG_DIR,
# ACTANA_DATA_DIR, ACTANA_BIN_DIR, XDG_DATA_HOME and XDG_CONFIG_HOME resolve
# there, in `packages/cli/src/actana-layout.ts`, where they are unit-tested
# against a fake home. A second, subtly different copy of those rules in POSIX
# sh is exactly the failure this repository refuses for release resolution.
# So: "fetch, verify, place" — and anything this script grows beyond that
# belongs in the CLI instead.
#
# Flags this script does not own are refused rather than forwarded. Every one
# it used to forward belonged to `actana setup`, and `actana setup` is a
# separate command now — passing `--yes` to an installer that prompts for
# nothing would be a flag that quietly did nothing.
#
# POSIX sh: runs under bash, dash and ash. Tested by
# `scripts/__tests__/install-sh.test.mjs` (the real script against a fixture
# release server) and by `scripts/e2e-actana-setup-linux.mjs`, which enters at
# the real one-liner on a real systemd machine, runs `actana setup` as its own
# next step, and carries on into the lifecycle verbs.

set -eu

DEFAULT_REPO="actana/control"
DEFAULT_API_BASE="https://api.github.com"
DEFAULT_DOWNLOAD_BASE="https://github.com"
SHASUMS_ASSET="SHA256SUMS"

REPO="${ACTANA_REPO:-$DEFAULT_REPO}"
VERSION="${ACTANA_VERSION:-}"
# One base URL replaces both of GitHub's hosts. That is what lets CI run the
# real one-liner against locally built artifacts, with no published release and
# no network.
BASE_URL="${ACTANA_BASE_URL:-}"

say() {
  printf '%s\n' "$*"
}

# Failures print what went wrong and what to do about it, then stop before
# anything from the download has run.
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

usage() {
  cat <<'EOF'
Install the Actana Control Core bundle and the `actana` CLI on this machine.

Installing is not activating. This script places the bundle and links the
launcher; it starts nothing and configures nothing. It prints the
`actana setup` command to run next, which is what turns this machine into a
Core: the pairing material, the auto-start service, lingering, the Harness
offers and the daemon.

Usage:
  curl -fsSL <install-script-url> | bash
  curl -fsSL <install-script-url> | bash -s -- [options]

and then, as a separate command this script does not run for you:
  actana setup [options]

Options:
  --version <v>     Install this exact release (default: the latest release)
  --repo <slug>     GitHub repository to install from
  --base-url <url>  Fetch releases from here instead of GitHub (testing)
  --help            Show this help

These four are the whole of it. Options this script does not own are refused
rather than ignored: `--yes`, `--port`, `--public-host`, `--label`,
`--with-<harness>` and `--no-harnesses` are `actana setup`'s, and belong on the
command this one prints. `actana setup --help` lists them.

Environment: ACTANA_VERSION, ACTANA_REPO, ACTANA_BASE_URL set the same three
installer options, for provisioning systems where flags are awkward.
ACTANA_HOME, ACTANA_BIN_DIR, ACTANA_CONFIG_DIR, ACTANA_DATA_DIR and the XDG
variables move where the bundle lands; they are read by the CLI, so this
script and `actana setup` cannot disagree about where anything is.
EOF
}

# ─── argument parsing ────────────────────────────────────────────────────────

# This script owns four options and refuses everything else.
#
# It used to collect the rest, shell-quote them and restore them into "$@" for
# `actana setup`. That machinery is gone with the call it fed: the flags it
# carried are decisions about how this machine is configured as a Core, and
# they belong on the command the operator runs next. Refusing is the honest
# answer — an installer that accepted `--public-host core1.example.com` and
# then did nothing with it would silently drop the one setting that decides
# whether a Panel can ever reach this machine.
setup_flag_refusal() {
  die "$1 is an \`actana setup\` option, and this script no longer runs setup.
  It installs the Core bundle and the CLI, then prints the \`actana setup\` line
  to run next — pass $1 to that command instead. \`--help\` lists the four
  options this script does own."
}

# A flag's value must be present and must not itself look like a flag:
# `--version --repo` silently pinning a release called "--repo" and swallowing
# the `--repo` is the kind of quiet wrong that only shows up as "why did it
# install nothing" much later.
need_value() {
  case ${2-} in
    "" | -*) die "$1 needs a value$3" ;;
  esac
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --version)
        need_value --version "${2-}" " (e.g. --version 0.1.0)"
        VERSION=$2
        shift 2
        ;;
      --version=*)
        need_value --version "${1#*=}" " (e.g. --version=0.1.0)"
        VERSION=${1#*=}
        shift
        ;;
      --repo)
        need_value --repo "${2-}" " (e.g. --repo owner/name)"
        REPO=$2
        shift 2
        ;;
      --repo=*)
        need_value --repo "${1#*=}" " (e.g. --repo=owner/name)"
        REPO=${1#*=}
        shift
        ;;
      --base-url)
        need_value --base-url "${2-}" ""
        BASE_URL=$2
        shift 2
        ;;
      --base-url=*)
        need_value --base-url "${1#*=}" ""
        BASE_URL=${1#*=}
        shift
        ;;
      --help | -h)
        usage
        exit 0
        ;;
      # Named one by one rather than swept up by the wildcard below, so an
      # operator pasting a command line from before the split is told where
      # their flag went instead of reading "unknown option".
      --yes | -y | --port | --port=* | --public-host | --public-host=* | \
        --label | --label=* | --host | --host=* | --no-harnesses | --with-*)
        setup_flag_refusal "${1%%=*}"
        ;;
      *)
        die "unknown option: $1. \`--help\` lists the four options this script owns;
  everything else belongs on the \`actana setup\` line it prints when it is done."
        ;;
    esac
  done
}

# ─── platform ────────────────────────────────────────────────────────────────

# Maps this machine to one of the three release targets, or explains why there
# is no build for it. Windows is not an omission: its operators run the web
# Panel and host their Cores on Linux (WSL counts as Linux).
#
# An Apple-silicon Mac is a first-class Core (`mac-arm64`). An Intel Mac is not
# and never will be — it runs its Core from the container image, and is told so
# by name rather than lumped in with the platforms Cores do not run on.
#
# Both refusals happen here, at detection, rather than later against the
# release's checksum file. Mapping an Intel Mac to `mac-x64` and letting the
# download fail produced "release v0.1.0 has no build for mac-x64" — which
# reads as a broken release, when the truth is an asset that will never exist.
# `releaseTargetFor` in packages/core/src/actana-release.ts mirrors every shape
# here, refusals included.
detect_target() {
  uname_s=$(uname -s)
  uname_m=$(uname -m)

  case $uname_s in
    Linux) platform="linux" ;;
    Darwin) platform="mac" ;;
    *)
      die "unsupported operating system: $uname_s. Cores run on Linux
  (WSL counts as Linux) and on Apple-silicon macOS; on Windows, use the web
  Panel and host your Core on a Linux machine."
      ;;
  esac

  case $uname_m in
    x86_64 | amd64) cpu="x64" ;;
    aarch64 | arm64) cpu="arm64" ;;
    *)
      die "unsupported architecture: $uname_m. Cores run on x86_64 and arm64."
      ;;
  esac

  # Rosetta makes an Apple-silicon Mac report `x86_64` from `uname -m`, so
  # `uname` alone would refuse a supported machine as an Intel one — a shell
  # opened under Rosetta is a normal way to end up here. sysctl knows the
  # difference: `sysctl.proc_translated` is 1 in a translated process, 0 in a
  # native one, and absent on a real Intel Mac, where the command fails and
  # leaves this empty.
  if [ "$platform" = "mac" ] && [ "$cpu" = "x64" ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    cpu="arm64"
  fi

  if [ "$platform" = "mac" ] && [ "$cpu" != "arm64" ]; then
    die "no Core build for an Intel Mac ($uname_m). The on-device install is
  Apple silicon only; on an Intel Mac, run your Core from the container image
  instead — the reference deploy/docker-compose.yml at
  https://github.com/actana/control brings up a Core in one command."
  fi

  TARGET="$platform-$cpu"
}

# ─── fetching ────────────────────────────────────────────────────────────────

# Fetch a URL to a file, or to stdout when no destination is given.
# `--retry` only, without `--retry-connrefused`: the latter is a curl 7.52
# option, and an installer that fails on an older curl helps nobody.
fetch_url() {
  if have curl; then
    curl -fsSL --retry 3 -o "${2:--}" "$1"
  elif have wget; then
    wget -q -O "${2:--}" "$1"
  else
    die "neither curl nor wget is installed — one of them is needed to download the Core."
  fi
}

# The digest of a file, using whatever the machine has. GNU coreutils ships
# sha256sum, macOS ships shasum; openssl is the fallback for the rest.
sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif have openssl; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "no SHA-256 tool found (looked for sha256sum, shasum, openssl) — cannot verify the download."
  fi
}

# ─── release resolution ──────────────────────────────────────────────────────

# `latest` is one API call; a pinned version is none. A pinned install that
# still asked what the latest release was would be one API change away from
# quietly installing something else.
resolve_version() {
  if [ -n "$VERSION" ]; then
    VERSION=${VERSION#v}
    return 0
  fi

  latest_url="$API_BASE/repos/$REPO/releases/latest"
  latest_json=$(fetch_url "$latest_url") ||
    die "could not fetch $latest_url. Either $REPO has no releases, or this machine
  cannot reach it — check the network, or pin a version with --version."

  # Splitting on the JSON punctuation first keeps this honest whether the API
  # answers pretty-printed or on one line. LC_ALL=C because the release body is
  # arbitrary text and some seds reject bytes that are invalid in the locale.
  VERSION=$(
    printf '%s' "$latest_json" |
      LC_ALL=C tr '{,' '\n\n' |
      LC_ALL=C sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' |
      head -n 1
  )
  [ -n "$VERSION" ] || die "no release tag in the answer from $latest_url — is $REPO the right repository?"
}

# ─── main ────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"

  if [ -n "$BASE_URL" ]; then
    BASE_URL=${BASE_URL%/}
    API_BASE="$BASE_URL"
    DOWNLOAD_BASE="$BASE_URL"
  else
    API_BASE="$DEFAULT_API_BASE"
    DOWNLOAD_BASE="$DEFAULT_DOWNLOAD_BASE"
  fi

  have tar || die "tar is not installed — it is needed to unpack the Core."

  detect_target
  resolve_version

  tag="v$VERSION"
  asset="actana-core-$VERSION-$TARGET.tar.gz"
  release_url="$DOWNLOAD_BASE/$REPO/releases/download/$tag"

  say "Installing the Actana Core $VERSION for $TARGET."

  work_dir=$(mktemp -d 2>/dev/null || mktemp -d -t actana-install)
  # Whatever happens next — a bad checksum, a refused placement, Ctrl-C — the
  # download does not outlive this script. What does outlive it is whatever
  # `place` copied out of here, which is the point of the call at the bottom.
  trap 'rm -rf "$work_dir"' EXIT
  trap 'rm -rf "$work_dir"; exit 130' INT
  trap 'rm -rf "$work_dir"; exit 143' TERM

  # Checksums first: they name every artifact in the release, so they answer
  # both "does this release exist" and "does it have a build for me" before a
  # single byte of tarball is downloaded.
  sums_file="$work_dir/$SHASUMS_ASSET"
  fetch_url "$release_url/$SHASUMS_ASSET" "$sums_file" ||
    die "could not fetch $release_url/$SHASUMS_ASSET. Either there is no release $tag,
  or this machine cannot reach $DOWNLOAD_BASE — check the version, or drop
  --version to install the latest."

  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$sums_file" | head -n 1)
  [ -n "$expected" ] || die "release $tag has no build for $TARGET.
  Its $SHASUMS_ASSET does not list $asset."

  say "Downloading $asset…"
  tarball="$work_dir/$asset"
  fetch_url "$release_url/$asset" "$tarball" ||
    die "could not download $release_url/$asset"

  actual=$(sha256_of "$tarball")
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for $asset — refusing to run it.
  expected $expected
  actual   $actual
  Nothing was installed. Retry the install; if it keeps failing, the release
  assets or the connection between here and them cannot be trusted."
  fi
  # What this proves: the tarball is the one the release's own checksum file
  # describes. Both came over the same channel, so it catches corruption and
  # truncation, not a release channel someone else controls — the project
  # publishes no signatures. Why that is safe, and what would change it:
  # docs/ci-cd.md, "Integrity is published checksums, not signatures".
  say "Checksum verified against the release's $SHASUMS_ASSET."

  tar -xzf "$tarball" -C "$work_dir" || die "could not unpack $asset"
  extracted="$work_dir/actana-core-$VERSION-$TARGET"
  [ -x "$extracted/bin/actana" ] ||
    die "$asset does not contain bin/actana — the release asset looks wrong."

  say ""
  # **The line that makes any of this survive.** The tree above is inside
  # `work_dir`, which the EXIT trap deletes; `place` copies it into
  # `versions/<version>`, points `current` at it and links the launcher. Take
  # this call away and a successful run leaves the machine exactly as it was
  # found.
  #
  # Run rather than `exec`: the EXIT trap is what removes the download, and an
  # exec'd process has no trap to run. `set -e` carries a failure out with its
  # own status, so a caller still sees what went wrong — there is no longer a
  # separate exit code to propagate, because there is no longer a `setup` run
  # to propagate one from.
  #
  # stdin is /dev/null on every path, terminal or not. In the one-liner the
  # rest of this script is still on stdin, and handing that to a child would
  # let it eat the script; `place` has nothing to read there in any case. It is
  # `actana setup` that talks to an operator, and that is their next command,
  # run with their own terminal attached.
  #
  # What it prints — including the exact `actana setup` line to run next, as an
  # absolute path when `<binDir>` is not on PATH — is printed by the CLI, which
  # is the half that knows the layout. This script deliberately does not print
  # a second copy of it.
  "$extracted/bin/actana" place </dev/null
}

# Everything above is a definition, so the shell has read this whole script
# before any of it runs — the piped-install hazard where the last lines are
# still on stdin when a child process reads it.
main "$@"
