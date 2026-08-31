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
# **The copy you fetched decides what it installs** (ADR 0036 D1). A script
# read from a pipe cannot know its own URL — there is no `$0`, no BASH_SOURCE,
# no argv naming one — so "the ref is the channel" can only mean that the copy
# of this file on that ref differs. Each copy therefore carries the *line* it
# was cut from, written by the cut; `resolve_version` turns that line into a
# release tag or into that line's beta tag. There is no `--channel` flag and no
# environment variable for it: promotion is a fast-forward, so a channel
# constant committed on a train would become `main`'s own bytes.
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
# Where $VERSION came from, in words, for the one message that has to say so:
# a failed download can no longer assume a flag was passed (see `main`).
VERSION_ORIGIN=""
# One base URL replaces both of GitHub's hosts. That is what lets CI run the
# real one-liner against locally built artifacts, with no published release and
# no network.
BASE_URL="${ACTANA_BASE_URL:-}"

# ─── the line this copy installs (ADR 0036 D1) ───────────────────────────────
#
# The one value a cut writes into this file, alongside the six manifests
# (docs/ci-cd.md § "Cutting a train"). It is a **line** — `x.y.z` — and not a
# channel: `resolve_version` below turns it into either that line's release or
# that line's beta, which is what makes the same bytes correct on a train,
# where only the beta tag exists, and on `main` after the promotion
# fast-forward has made those bytes main's own.
#
# One assignment on one line, so the cut can rewrite it in place and a reviewer
# can see the whole of the change. Copied verbatim from docs/ci-cd.md, down to
# the `-i.bak`, because this comment sits one line above the value being edited
# and is the copy-paste source a person cutting a train reaches for first —
# BSD `sed` on macOS requires an argument to `-i` and GNU `sed` accepts one:
#
#   sed -i.bak 's/^LINE=".*"$/LINE="x.y.z"/' install.sh && rm -f install.sh.bak
LINE="0.4.3"

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
  --version <v>     Install this exact version, release or beta. Overrides
                    everything below; the default is this copy's own line
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
  # The channel this copy installs from — printed rather than written into the
  # heredoc above, because it is the one line of this help that differs between
  # copies of the script (ADR 0036 D1, D2).
  printf '\n'
  printf 'This copy is stamped with the %s line, and that stamp is its channel:\n' "$LINE"
  printf 'it installs v%s if that release exists, otherwise v%s-beta, and\n' "$LINE" "$LINE"
  printf 'otherwise the newest release. Which copy you fetched is the whole of\n'
  printf 'the choice: there is no --channel option and no environment variable\n'
  printf 'that selects one.\n'
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

# The HTTP status of one GET, as three digits, or the empty string when the
# request never reached an answer at all — DNS, TLS, or a refused connection.
#
# **This exists because absence and failure are different answers, and an exit
# code cannot tell them apart.** curl and wget fail a 404, a 403 rate limit, a
# 502 and a dead resolver identically, so a probe that read the exit code would
# call all of them "no such release" — and under D2 that turns one transient
# failure on the step-2 probe into a beta served from the public door, which is
# the outcome D1 exists to prevent, and turns C4's pinned second row into a
# floating install. Nothing here parses a body; the status is the whole answer.
#
# No `--retry` on the curl call, deliberately: `--retry` cannot rewind
# `-o /dev/null`, so a retried 5xx ends as a write error with **no code
# printed** — the one input this function exists to return. Retrying is
# `http_status`'s job, one line down, where a status can be looked at first.
http_status_once() {
  if have curl; then
    # No `-f`: the body is discarded either way, and `-f` would hide the very
    # status this is here to read. `%{http_code}` is the last response's, so a
    # redirect is followed to the answer that matters, and a transport failure
    # prints `000` — which this reports as no answer rather than as one.
    status=$(curl -sSL -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true)
    case $status in
      000 | "" | *[!0-9]*) status="" ;;
    esac
    printf '%s' "$status"
    return 0
  fi

  # wget has no `-w`, so the status is read out of what it says. GNU wget
  # prints the response headers under `-S`; busybox's rejects `-S` outright but
  # names the code in its own line. So the header form is tried first, the bare
  # run is the fallback, and both shapes are matched — and when neither yields
  # a code, this returns nothing and the caller stops rather than guessing.
  for wget_opt in -S ""; do
    status=$(
      LC_ALL=C wget $wget_opt -O /dev/null "$1" 2>&1 |
        LC_ALL=C sed -n \
          -e 's|.*HTTP/[0-9.]*[[:space:]]\{1,\}\([0-9][0-9][0-9]\).*|\1|p' \
          -e 's|.*response\.\.\.[[:space:]]*\([0-9][0-9][0-9]\).*|\1|p' |
        tail -n 1
    )
    if [ -n "$status" ]; then
      break
    fi
  done
  printf '%s' "$status"
}

# The same, retried while the answer looks transient.
#
# `fetch_url` gets its retries from curl; this one cannot (see above), so the
# loop is here and it is the better place for it anyway: a 404 is an answer and
# is returned at once, while a 429, a 5xx or no answer at all is worth asking
# again before an install is refused over a blip.
http_status() {
  attempt=1
  while :; do
    status=$(http_status_once "$1")
    case $status in
      "" | 429 | 5[0-9][0-9]) ;;
      *) break ;;
    esac
    if [ "$attempt" -ge 3 ]; then
      break
    fi
    sleep "$attempt"
    attempt=$((attempt + 1))
  done
  printf '%s' "$status"
}

# Does $REPO publish a Release on this tag?
#
# Three answers, not two: yes, no, and "the question could not be asked". Only
# a clean 404 is absence. Anything else stops the install here, because every
# other status is a statement about the connection or about GitHub rather than
# about this release — and falling through on one would pick a *different*
# version to install, silently. `--version` needs none of this and is what the
# messages point at.
release_exists() {
  tag_url="$API_BASE/repos/$REPO/releases/tags/$1"
  tag_status=$(http_status "$tag_url")
  case $tag_status in
    200) return 0 ;;
    404) return 1 ;;
    "")
      die "could not reach $tag_url while resolving the $LINE line.
  That is not the same as \"there is no such release\", so nothing is installed
  rather than something else being chosen — check the network, or name the
  version you want with --version, which asks nothing."
      ;;
    *)
      die "$tag_url answered HTTP $tag_status while resolving the $LINE line.
  403 is usually GitHub's unauthenticated rate limit, 60 requests an hour per
  IP; 5xx is GitHub. Neither means the release is missing, so nothing is
  installed rather than a different version being chosen — retry later, or name
  the version you want with --version, which asks nothing."
      ;;
  esac
}

# **The mechanism is ADR 0036 D1's stamped line, and this is the whole of D2.**
# In order:
#
#   1. an explicit --version / ACTANA_VERSION wins, and asks nothing;
#   2. the release `v<line>`, if that Release exists;
#   3. otherwise `v<line>-beta`, if that Release exists;
#   4. otherwise `/releases/latest` — exactly what this script read before the
#      stamp existed, kept as the terminal fallback.
#
# On a train only the beta tag exists, so step 3 answers. On `main` after a
# promotion the release exists, so the same bytes answer at step 2. At a
# release tag the stamp is that tag's own version and step 2 pins it, and at a
# beta tag the file carries the line like every other copy — which is why that
# ref is an alias for the train's door and not a pin. The pinned beta form is
# `--version x.y.z-beta`, and step 1 is where it is served.
#
# **No step lists releases.** `GET /repos/<repo>/releases` answers every line
# newest-first, so "the newest prerelease" would hand a machine installing the
# beta of one line the beta of another. Resolution is per line by construction
# instead: the stamp names the tag, and the steady-state path is the single
# call at step 2 — the same number the stable path made before this.
#
# **Step 4 is not decoration.** A line with neither a release nor a beta cut
# from it yet is a real state, not a hypothetical, and today's answer is the
# right one for a line that has published nothing.
resolve_version() {
  if [ -n "$VERSION" ]; then
    VERSION=${VERSION#v}
    VERSION_ORIGIN="That version came from --version or ACTANA_VERSION — check it, or drop it to
  take the version this copy of the script installs by default."
    return 0
  fi

  if [ -n "$LINE" ]; then
    if release_exists "v$LINE"; then
      VERSION=$LINE
      VERSION_ORIGIN="Nothing chose that version: it is the $LINE line this copy of the script is
  stamped with, and there is no flag to drop. Name another with --version."
      return 0
    fi
    if release_exists "v$LINE-beta"; then
      VERSION="$LINE-beta"
      VERSION_ORIGIN="Nothing chose that version: it is the current beta of the $LINE line this copy
  of the script is stamped with, and there is no flag to drop. Name another
  with --version."
      return 0
    fi
  fi

  latest_url="$API_BASE/repos/$REPO/releases/latest"
  latest_json=$(fetch_url "$latest_url") ||
    die "the $LINE line has neither a release nor a beta, and $latest_url could not
  be fetched either. Either $REPO has no releases, or this machine cannot reach
  it — check the network, or pin a version with --version."

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
  VERSION_ORIGIN="Nothing chose that version: it is the newest release $REPO publishes, and there
  is no flag to drop. Name another with --version."
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
  # Asked once, here, rather than left to the first fetch. `http_status`
  # redirects wget's own stderr into a pipe it parses, so a `die` raised from
  # inside a probe would be swallowed on its way out; asking up front means the
  # machine that has neither tool is told so instead of exiting silently.
  have curl || have wget ||
    die "neither curl nor wget is installed — one of them is needed to download the Core."

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
  or it publishes no checksums, or this machine cannot reach $DOWNLOAD_BASE.
  Nothing was installed.
  $VERSION_ORIGIN"

  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$sums_file" | head -n 1)
  [ -n "$expected" ] || die "release $tag has no build for $TARGET.
  Its $SHASUMS_ASSET does not list $asset."

  say "Downloading $asset..."
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
