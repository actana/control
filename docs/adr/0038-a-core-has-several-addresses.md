# A Core has several addresses: multi-SAN certificates, and a per-pairing endpoint

> **Status: PROPOSED.** Not accepted. This record **amends**
> [ADR 0016](0016-the-0-1-0-shape.md) at **D15** and **D18**, and adds a clause
> to the pairing surface [ADR 0034](0034-short-code-pairing-enrollment.md)
> bounds. Both records are `ACCEPTED` and stay so: they are amended by dated
> notes appended under the clauses named — never superseded, never renumbered,
> never rewritten. **The repository owner ratifies or rejects this record**, and
> until then nothing in it is settled.

> **On the number.** This record takes **0038**, the next free number:
> `docs/adr/` runs to [`0037-one-version-per-line.md`](0037-one-version-per-line.md).
> [`README.md`](README.md)'s rule is **append a clause, never shift one**.

> **On citations.** A bare `D<n>` in this file means a clause **of this
> record**. A clause of another record is always written with its ADR —
> `0016 D18`, `0032 D9`, `0034 D2`.

[#347](https://github.com/actana/control/issues/347) reports it from the
reference deployment: a Core in Docker Compose beside its Panel, reached
internally as the service name `core`, that a developer also wants to reach
from a host-machine CLI — which needs an externally routable address, because
`localhost` inside one container is not the host.

Today `ACTANA_PUBLIC_HOST` is **one** address and it is three things at once:
the operator-sourced subject alternative name on the server certificate, the
`endpoint` every pairing hands back, and the name a client's TLS stack verifies
on every dial afterwards. Serving both clients therefore means changing that
one value, and changing it re-signs the certificate for the new name **only**
(0016 D18): every client still dialling the old name fails
`ERR_TLS_CERT_ALTNAME_INVALID`, the Panel included. A LAN address is usually
DHCP-assigned, so it can go stale and do it again.

The triage on #347 recommended the certificate half alone, on the argument that
hostname verification is done by the client against the *server* certificate,
so a per-pairing address "is multi-SAN plus a new input path". That argument is
correct and it is not the whole problem. Multi-SAN makes several addresses
*valid*; it does not decide **which one a given client is told to use**, and
that is the case the ticket opens with — one Core, several clients, each
needing a different address for the same Core. A Panel handed the LAN address
and a CLI handed the service name are both holding a credential the
certificate covers and neither can route to it. So both halves ship.

---

## A. The two halves

**Half A — the certificate.** `ACTANA_PUBLIC_HOST` becomes a comma-separated
list, and every entry becomes a SAN.

**Half B — the pairing.** `actana pair new --public-host <addr>` chooses which
of *those* addresses that one code's redemption hands back.

Half B is constrained by half A and is worth nothing without it: the flag
selects from the configured list and can never extend it. That constraint is
the design, not a validation detail, and D5 is where it is written down.

---

## B. Decisions

**D1 — One variable, one or more addresses; the first is the primary.**
`ACTANA_PUBLIC_HOST` (and `actana setup --public-host`) takes a comma-separated
list. Entries are trimmed, repeats collapse keeping first position, and an
**empty entry is refused** naming the variable — `core,,10.0.0.5` is a doubled
comma, and reading it as the two-host list it resembles would mint a
certificate the operator did not ask for and say nothing about the third they
thought they had written. The **first entry is the primary**: the certificate's
common name, the endpoint a pairing hands back when nothing else was chosen,
the default `ACTANA_LABEL`, and the address `actana setup` prints. Order is
therefore part of the operator's answer, which is why D3's comparison is
order-sensitive. *(Amends 0016 D15, which reads "the address" throughout; the
variable does not change name, and the image still never guesses it.)*

**D2 — A single value keeps working, unchanged, and it is proved rather than
promised.** A compose file setting one host parses to a list of one, mints the
same SAN list from the same builder, records the same host, hands back the same
endpoint and writes the same `AC_CORE_PUBLIC_HOST` into the same unit. This is
the compatibility clause of the whole record and it is asserted **against the
minted certificate**, not against the input list:
`core-cert-material.test.ts` reads the SAN extension back off a certificate and
compares it entry by entry to what the single-host builder produced, and
`core-first-run.test.ts` additionally asserts that the boot after an upgrade
re-issues nothing. The one visible difference is that a duplicate SAN entry is
no longer emitted — `ACTANA_PUBLIC_HOST=127.0.0.1` used to put
`IP Address:127.0.0.1` in the extension twice, since the loopback pair is
appended unconditionally. A certificate naming one address twice verifies
identically.

**D3 — The material records the whole list, and a changed list is a move.**
`PersistedMaterial.serverHosts` replaces the single `serverHost` (0016 D18),
and `checkServerCertHost` compares lists **in order**. Order counts because
the primary is the endpoint: a reordered list is a Core whose clients are being
sent somewhere else, and calling it `covered` would leave the recorded primary
disagreeing with the configured one for the life of the install. Material
written before this record carries `serverHost` and is read as a list of one,
so an installed Core upgrades without re-issuing anything; a newer file read by
an older build lands on that build's existing "unrecorded" path — one silent
re-issue for its single host. *(Amends 0016 D18. Everything that clause bounds
is untouched: the CA, the bearer secret, the `coreId`, the `coreUuid` and the
client certificate all survive a re-issue; a public host the operator never
declared still re-signs nothing; `actana token regenerate` is still the only
deliberate re-mint.)*

**D4 — The loopback pair is still appended to every server certificate.**
`localhost` and `127.0.0.1` go into every SAN list, on the mint path and the
re-issue path both, so the machine's own CLI can dial the Core it is standing
on (0032 D9, `core-self-register.ts`). The operator's list is **added to** that
pair, never a replacement for it. They are not selectable at `pair new`: D5's
list is the operator-configured one, so a pairing code cannot hand a remote
client a loopback address.

**D5 — A pairing code may only name an address the certificate already
covers.** `actana pair new --public-host` validates its argument against
`serverHosts` — the record of what was actually signed — and refuses anything
else, printing the configured list and naming the primary. Nothing is written
on the refusal path: no code is printed and no session is stored. The check is
against the *material* rather than against `actana.json` because the material
is the certificate's own provenance record and cannot have drifted from it.
**This is the entire point of the shape**: a code that handed back an address
the certificate does not cover would hand its client a credential that fails
hostname verification on its first dial, which is a worse failure than
refusing to mint it — it happens on the client's machine, minutes later, to
somebody who cannot see this Core's configuration.

**D6 — The redeem endpoint is per session, resolved from the stored session.**
`core-pairing-routes.ts`'s `endpoint` option — one string for the whole route —
becomes `endpointFor(session)`. `PairingSession` gains one optional field,
`endpointHost`, set by `pair new --public-host` and absent (meaning the
primary) otherwise; the SDK's wire types do not change, because the response
already carries an `endpoint` and only its value is now per-client.
`core-pairing-wiring.ts` builds the resolver the daemon uses, and it enforces
D5 a second time: a stored host that is no longer configured falls back to the
primary. That second check is not belt-and-braces about the CLI, it is about
time — an operator can shorten `ACTANA_PUBLIC_HOST` while a code minted against
the longer list is still live, and by then the certificate no longer covers the
address that code was going to name.

**D7 — The `Host` header is still not a source, and the reason has not
changed.** `core-pairing-routes.ts` has always refused to let anything the
caller sends decide the address a client pins: a `Host` header is chosen by the
caller, so a client that pinned it would have pinned whatever an attacker wrote
there. That comment still holds verbatim, and D6 does not weaken it. The only
input to `endpointFor` is the stored pairing session — a record the operator
wrote with `actana pair new`, on the machine that *is* the Core, before the
request existed. What changed is *which of the Core's own addresses* the answer
is; what did not change is that every candidate came from the Core. This is the
clause a review should check, and `core-pairing-redeem.test.ts` asserts it over
the wire with a `Host` header that lies. *(Adds to the surface 0034 D2 bounds:
`POST /v1/pair/redeem` stays the one pre-auth route, its request shape is
unchanged, and it reads one more field of state it already owned.)*

---

## C. Consequences

- A Core reachable two ways is configured once and pairs each client to the
  address that client can route to. Flipping LAN reachability on or off no
  longer cascades into re-pairing clients that were working.
- Adding an address to the list re-signs the server certificate — the recorded
  list changed, so D3 calls it a move — but from the CA already on disk, so
  every paired client stays paired and the address it holds stays covered.
  This is the reverse of the failure #347 reports.
- `pair ls` does not show which endpoint a pending code will hand back. It
  could, and the JSON row is where it would go; it is left out because this
  record is already two halves and `pair ls`'s output is not one of them.
- A stale `endpointHost` degrades to the primary rather than failing. An
  operator who removes an address while a code for it is live gets a client
  paired to the primary, which is reachable, rather than one paired to a name
  its certificate no longer carries.
- The three-things-at-once sentence in `deploy/README.md` is now two-and-a-half:
  the certificate covers every entry, the endpoint is the primary unless a code
  chose otherwise, and verification is per-address as it always was.
