# The built Core image, measured — 2026-08-04

Evidence for [actana/control#37](https://github.com/actana/control/issues/37), which asks one
question that a scan can answer and no amount of reading can:

> whether `apt-get upgrade` actually takes the OS surface from 21 distinct to ~6. 15 of the 21 are
> marked fixable so it should, but that is an inference from Trivy's `fixable` column, not a scan.

**Short answer: the ~6 is right, and our `apt-get upgrade` layer is not what delivers it today.**
Canonical already shipped those fixes into the base image. The upgrade is still correct to keep,
for the reason below, but the cadence justification in [#51] (T22) must not be written as though the
upgrade layer is currently paying for itself.

The #7 harness that produced the 21-distinct baseline (`build.sh`, `images.tsv`, `results.tsv`)
lives on the unlanded `phase-1-evidence` branch, so this file is self-contained rather than a new
row in `results.tsv`.

## Conditions

| | |
|---|---|
| Scanner | **Trivy 0.73.0**, vuln DB pulled 2026-08-04 |
| Command | `trivy image --input <image>.tar --format json` — unfixed CVEs **included** (Trivy's default) |
| Builder | podman, rootless |
| Host arch | `linux/arm64` |
| Base | `ubuntu:24.04@sha256:561618e2…` — the digest `deploy/core.Dockerfile` pins, `noble-20260730.1` |
| Core | `actana-core-0.1.0-linux-arm64.tar.gz`, Node 24.18.1 |

`MB` is podman's uncompressed image size, as in `results.tsv`.

## Rows

| # | image | MB | findings | distinct | fixable | CRIT | HIGH | of which `linux-libc-dev` |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| A | base, untouched | 103 | 14 | 6 | 0 | 0 | 0 | 0 |
| B | A + `apt-get upgrade -y` | 103 | 14 | 6 | 0 | 0 | 0 | 0 |
| C | B + package set **without** `build-essential python3` | 203 | 29 | 15 | 0 | 0 | 0 | 0 |
| D | B + the full D6 package set | 475 | 1304 | 1227 | 0 | 1 | 54 | 1200 |
| E | D + Node 24.18.1 + the Core tarball — **the shipped image** | 805 | 1323 | 1246 | 19 | 2 | 60 | 1200 |

## What the rows say

**A → B: the upgrade is a no-op on this digest.** Not "small" — zero. `apt-get -s upgrade` on the
pinned base reports `0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded`, and the scan
is byte-identical either side. Every one of the 6 distinct findings on the base is *unfixed*: there
is no update to collect.

This does not make D5 wrong, and the layer must stay. The 21 distinct / 15 fixable that #7 measured
on 2026-08-03 was the *rolling* `ubuntu:24.04` tag; today that tag resolves to `noble-20260730.1`,
which has already absorbed those fixes — which is exactly D5's point that the tag is not a pin. What
changes now is that the digest **is** pinned, so from here on the only route by which a Canonical
fix can reach a rebuild is the upgrade layer. It is prepaid insurance, not current value, and [#51]
should say so rather than claim a 21→6 drop it is not producing.

**C → D: `linux-libc-dev` is 1200 findings, exactly as D6 says.** 1227 distinct with the toolchain,
15 without, and 1200 of the 1227 are attributed to that single package. D6's "1200 of the 1328 OS
findings" and "dropping that one package alone takes an unchanged `ubuntu:24.04` build from 1248 to
38" are confirmed on the mechanism, and the "the base did the work" summary the ADR warns against is
confirmed false: the base contributes 6.

**Distinct CVEs after D7's suppression: 46, against the ticket's ~38.** 1246 − 1200 = 46. The extra
~8 are the Node/npm rows in row E that the #7 baseline did not carry, not OS drift. Nothing on the
OS side is a surprise.

**Size is 805 MB, against the ticket's ~190 MB, and the ticket's figure cannot be met as specified.**
Row C is 203 MB — the ~190 MB is the package set *without* the native-addon toolchain. But D7 keeps
`build-essential` and `python3` deliberately, and they are +272 MB (row C → D); Node 24 and the Core
tarball are a further +330 MB. `751 → ~190 MB` and "toolchain in" are not simultaneously achievable,
and the 190 in D6 should be read as the toolchain-free row it was measured on. The CVE half of that
sentence holds; the size half does not, and this is the one number in the ticket the build refutes.

## The CVE gate would be red — and `NODE_VERSION` does not fix it

D11 gates on **fixable** CRITICAL or HIGH. Row E has seven, and every one of them is in the *system*
Node's own bundled npm:

| severity | CVE | package | path |
|---|---|---|---|
| CRITICAL | CVE-2026-59873 | tar 7.5.15 | `usr/local/lib/node_modules/npm/node_modules/tar` |
| HIGH | CVE-2026-59874 | tar 7.5.15 | same |
| HIGH | CVE-2026-12151 | undici 6.26.0 | `…/npm/node_modules/undici` |
| HIGH | CVE-2026-13149 | brace-expansion 5.0.6 | `…/npm/node_modules/brace-expansion` |
| HIGH | CVE-2026-14257 | brace-expansion 5.0.6 | same |
| HIGH | CVE-2026-69152 | brace-expansion 5.0.6 | same |
| HIGH | CVE-2026-69192 | ip-address 10.2.0 | `…/npm/node_modules/ip-address` |

**Fixable CRITICAL/HIGH from OS packages: zero.** All seven are npm's vendored dependencies.

D10 says a `NODE_VERSION` bump "is the only thing that clears the Node-attributed findings". Built
and scanned: **24.19.0 (npm 11.17.0) clears none of them.** It moves `tar` 7.5.15 → 7.5.16, which is
still below the 7.5.19 fix, and leaves undici, brace-expansion and ip-address untouched. No released
Node 24 line currently ships an npm whose bundled tree is clean.

This lands on [#38] (T38), which builds the gate. It has three honest options and none of them is
"bump Node": scope the gate to `os-pkgs`, add the npm tree to `.trivyignore` with the same
justification discipline D7 demands, or drop the bundled npm from the image. Nothing in this ticket
decides it — but #38 cannot be written on D10's assumption, because the assumption is measured false.

## Reproducing

```sh
pnpm core:tarball
podman build --file deploy/core.Dockerfile --build-context tarball=artifacts/core \
             --tag actana-core:measure deploy
podman save -o core.tar actana-core:measure
trivy image --input core.tar --format json --output core.json

# distinct, excluding the suppressed kernel headers
jq '[.Results[]?.Vulnerabilities[]? | select(.PkgName!="linux-libc-dev") | .VulnerabilityID]
    | unique | length' core.json

# the D11 gate
jq -r '[.Results[]?.Vulnerabilities[]? | select(.Status=="fixed")
        | select(.Severity=="CRITICAL" or .Severity=="HIGH")
        | "\(.Severity) \(.VulnerabilityID) \(.PkgName)"] | unique[]' core.json
```

Rows A–D are the same commands against the cut-down Dockerfiles described in the table; each is the
shipped file with instructions removed from the bottom up.

[#51]: https://github.com/actana/control/issues/51
[#38]: https://github.com/actana/control/issues/38
