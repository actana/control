# The repository's only vulnerability *allowlist*: one file, one entry, and
# growing it is a spec change (ADR 0016 D7, D37), not a build fix.
#
# It is not, on its own, the only suppression. The gate also scopes the system
# Node's bundled npm tree out by path — that one lives in
# scripts/lib/image-cve-gate.mjs, deliberately not in here, so "one file, one
# entry" stays literally true and the two stay different in kind. Two in
# total, both written down, and D7/D11 must be amended before there is a
# third.
#
# This file suppresses every finding attributed to `linux-libc-dev`, and the
# honest word for that is suppression — ~1200 of the 1323 findings a raw scan
# of the shipped image reports, taking it from 1246 distinct CVEs to 46.
#
# Why the toolchain that drags them in stays (D7):
#
#   `build-essential` pulls `libc6-dev` pulls `linux-libc-dev`. The toolchain
#   ships because that is what the product is: `npm install` on any project
#   with a native addon invokes node-gyp, which needs `make`, `g++` *and*
#   `python3`. This repository is the proof — it depends on `better-sqlite3`
#   and `node-pty`, so a Core without the toolchain cannot `pnpm install`
#   Actana Control itself, and the failure mode is a wall of node-gyp output
#   rather than "install build-essential".
#
# Why suppressing them is defensible, rather than convenient:
#
#   `linux-libc-dev` is kernel headers. 1008 of its 1015 files are under
#   /usr/include, there is no executable code in the package, and the kernel a
#   Core runs is the *host's* — the container never loads this one. Nothing in
#   the image can be exploited through a header it compiled against.
#
# What this does NOT hide: not one of those ~1200 is a fixable CRITICAL or
# HIGH, so the D11 gate would pass with this file deleted. What it buys is a
# readable report — without it, 1200 rows of kernel headers bury the 46
# findings a reader can act on.
#
# Applied with `trivy image --ignore-policy .trivyignore.rego`, which
# scripts/scan-core-image.mjs passes and then verifies actually took effect.
# A Rego policy rather than a plain `.trivyignore`, for one measured reason:
# `.trivyignore` and `.trivyignore.yaml` match on CVE id only. Naming a package
# in either one parses cleanly, filters nothing, and warns about nothing —
# "one entry, for linux-libc-dev" is not expressible there, and the version
# that looks like it is, is silently a no-op.

package trivy

import rego.v1

default ignore := false

ignore if input.PkgName == "linux-libc-dev"
