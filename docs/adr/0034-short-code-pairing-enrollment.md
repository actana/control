# Short-code pairing enrollment

> **Status: PROPOSED.** Not accepted. It records the design
> [#280](https://github.com/actana/control/issues/280) sets out and #281–#287
> implement on `feat/short-code-pairing`, written because CONTRIBUTING.md asks
> for one in the same pull request as the code, and #306's review found none.
> **The repository owner ratifies or rejects it at the beta gate.** A reviewer
> who disagrees with D2 or D7 is disagreeing with a proposal rather than routing
> around a decision.

A client used to be enrolled by hand-carrying a credential. The Core printed a
base64 `CoreRegistrationBlob` — CA certificate, client certificate, **client
private key**, endpoint — into its own logs, and an operator copied it into the
Panel's Add Core textarea or into `actana core add`. It worked, and three things
about it did not survive contact with the reference deployment:

- **The secret was in the transport.** The key travelled in the thing being
  pasted, so it was in a terminal scrollback, a log file, a clipboard, and
  whatever chat window carried it to the person at the other machine. Rotating
  it meant reissuing everything.
- **It was one credential, not one per client.** The blob was as re-pastable as
  it was pastable. Nothing in it named the machine it was meant for, so
  "unpair the laptop" had no answer short of `token regenerate`, which unpairs
  everything.
- **It could not be read aloud.** 2 KB of base64 is not something an operator
  reads down a phone line to the person standing at the build box.

[#280](https://github.com/actana/control/issues/280) replaces it with the shape
every other system in this position uses: the Core mints a short code, a person
carries the code, and the client turns the code into a credential it generated
itself. This record is what that costs and what it must never be allowed to
become — the pairing route is the only place this product accepts an
unauthenticated request, so the cost of getting it wrong is not a bad error
message.

## Decisions

**D1 — Enrollment is a short code the operator carries, and the code is not a
credential.** `actana pair new` opens a pairing *session* and prints an
eight-character code from a 31-character ambiguity-free alphabet
(`packages/shared/src/pairing-code.ts:40,43`), drawn from a CSPRNG with
reject-and-redraw so no character is likelier than another (`:55,:93`). The code
is single-use, expires in five minutes (`pairing-session.ts:29`) and dies after
a capped number of wrong guesses. It authorises exactly one certificate
issuance and is worthless afterwards. **It is not a bearer token and nothing
accepts it twice.**

**D2 — There is exactly one pre-auth route, and the handshake relaxation is
scoped to it.** `POST /v1/pair/redeem` is the only surface on a Core that an
unauthenticated caller may reach. Reaching it requires the Core's TLS server to
complete a handshake without a verified client certificate, which is a real
relaxation of [ADR 0002](0002-core-link-auth-and-transport.md) and is confined
three ways: `rejectUnauthorizedAtHandshake` relaxes the handshake **only when a
pre-auth surface is mounted** and is a named function with a reason and a test
rather than a ternary inside an options object
(`packages/core/src/core-preauth-gate.ts:104`); the gate re-enforces the
certificate requirement per request and per upgrade
(`pty-core-link-server.ts:2493,2396`); and the core-link itself is unreachable
without a certificate at any point. `core-pairing-redeem.test.ts` holds this as
a named case — *"the pre-auth hole is exactly one route wide"*. **A second
pre-auth route is a change to this decision, not a routine addition.**

> **Amended 2026-08-28 by [#347](https://github.com/actana/control/issues/347): the one route's
> `endpoint` becomes per-session, and the route count does not change.**
> [ADR 0038](0038-a-core-has-several-addresses.md) D6 and D7. `POST /v1/pair/redeem` is still the
> only pre-auth surface, still relaxes the handshake exactly the way this clause confines it, and its
> request shape is untouched — so the *"the pre-auth hole is exactly one route wide"* case still
> holds and was not edited. What changed is inside the 200 body: `endpoint` is resolved from the
> redeemed pairing session rather than being one string configured for the whole route, so a Core
> covering several addresses can tell each client the one it can reach. **The pre-auth caller gained
> no influence over it.** The resolver's whole input is the stored session — a record the operator
> wrote with `actana pair new` on the machine that is the Core, before the request existed — and the
> `Host` header is still not a source, for the reason this route has always given. A pairing code can
> only name an address the certificate already covers (0038 D5), enforced when the code is minted and
> again on the way out. Recorded here because 0038's header and `docs/README.md` both say it adds to
> the surface this clause bounds, and a clause that is added to should say so where it is read.

**D3 — The client's private key is born on the client and never crosses the
wire.** The client generates a key pair, sends a CSR, and the Core signs it
(`core-pairing-csr.ts:60`, `core-pairing.ts:393`). The redemption body is
exactly `{sessionId, code, client, csr}` and the 200 body is exactly
`{endpoint, caCert, clientCert, bearer}` — four fields, and *the absence of a
fifth is the point*. This is the decision that makes the whole change worth
making: after it, no part of enrollment carries a secret that both parties hold.

**D4 — The fingerprint is compared before the code is sent, on a connection
that trusts nothing.** First contact dials with `rejectUnauthorized: false` and
sends **nothing** (`core-pairing.ts:522`); the CA fingerprint is compared while
no secret exists (`:327-344`); redemption is a *second* connection pinned with
`ca:` + `rejectUnauthorized: true` + a `checkServerIdentity` that re-runs the
comparison (`:640-658`). A caller with no fingerprint is not a caller with a
waived one — it is answered with `fingerprint-unconfirmed` and the code stays
unsent. **No code path sends a code over an unverified connection.**

**D5 — Every refusal is the same refusal, and the distinction lives in the
audit log.** Wrong code, unknown session, expired, already redeemed, attempts
spent: one status, one body, one shape (`core-pairing-routes.ts:153`).
Distinguishable errors would tell an unauthenticated caller whether a session
exists and whether a guess was close. The operator's need is real and is met on
the Core, in the audit trail #282 put there. This collapses the four-way error
wording in #284/#285/#286 to one `refused`, and that is the correct resolution
of the conflict rather than an omission.

**D6 — The code is consumed before the certificate is signed.** The
read-modify-write at `pairing-store.ts:280` is synchronous and the route calls
it before signing (`core-pairing-routes.ts:326`), so two concurrent redemptions
of one code cannot both be issued a certificate. Validation order is fixed —
rate-limit → lookup/binding → revoked → TTL → single-use → attempt-cap → code
(`:220,253,274-277,283-286`) — and the code comparison is constant-time over an
HMAC digest of the canonical form (`pairing-store.ts:462`).

**D7 — `@peculiar/x509` joins the Core bundle, and that is a dependency
decision, not an implementation detail.** Signing a CSR requires parsing one,
and Node ships no X.509 CSR parser. `packages/shared/package.json:17` adds
`@peculiar/x509`, and because `packages/shared` is inlined into the Core image
(ADR 0032 D5) the dependency lands in the Core bundle. CONTRIBUTING.md names
this as an ADR trigger for a reason: it is a new library in the process that
holds the CA private key, and its parsing runs on **pre-auth input** (D2). The
containment is that `assertSignableCsr` rejects before signing and the body is
size-capped at 16 KB. **Replacing or removing this library is a change to this
decision.**

**D8 — The registration blob survives as an at-rest storage codec, and only
that.** `CoreRegistrationBlob`, `registration-blob.ts` and
`registration-blob-file.ts` are kept: a client still has to write down what it
learned. What is deleted is the blob as a *transport* — no emission, no log
sentinel, no paste surface, no `actana core add`, no `POST /api/cores`. The
distinction is the whole of #287: the shape stays, the hand-carry goes. What
still imports it is `local-core-wiring.ts` and two tests.

**D9 — Revocation invalidates the certificate, the bearer and the live link.**
`actana pair revoke` stamps `revokedAt`; the request, upgrade and connection
gates refuse the certificate, the `auth` frame refuses the bearer, and a one-
second sweep closes links already open (`pty-core-link-server.ts:closeRevoked`,
`core-pairing-revocation.ts`). A revocation that left an established socket
running would be a revocation in name only.

**D10 — An unreadable `pairing.json` fails closed, and every paired client is
refused until it is readable.** (`core-pairing-revocation.ts:141-183`.) This is
a new way for a Core to stop serving everyone, and it is chosen deliberately: a
half-written file or an unrecognised row must never silently un-revoke a
certificate an operator has taken back. Availability is the thing given up.
**It is recorded here because #280 does not sanction it and a reviewer should
meet it as a decision rather than discover it during an outage.**

**D11 — Enrollment hand-carries four things, not three.** #280 says code +
fingerprint + expiry; the session id travels too, because D6's binding hashes a
candidate code *with* its session id and so refuses to search for a session a
code might fit. The alternative — searching every open session for one the code
fits — is the oracle D5 exists to deny. #280's summary should be amended to
match the design that shipped.

**D12 — The redeem contract has exactly one definition.** Request and response
live in `packages/sdk/src/core-pairing-wire.ts`, an import-free module both the
SDK and the Core import; [ADR 0025](0025-the-protocol-ships-with-the-client.md)
D2 is amended in the same pull request to allow it. They were a hand-kept
mirror, which D3 of that record forbids, and the drift had already begun —
`client.platform` is sent by the CLI and the Panel and dropped by the Core's
parser.

## Considered options

- **Keep the blob and encrypt it with a passphrase (rejected).** Preserves the
  paste, so it preserves the property that a secret both parties hold travels
  through whatever channel carried it. It also adds a second thing to read
  aloud, and the failure mode of a wrong passphrase is indistinguishable from a
  corrupt paste.
- **Distinguishable pairing errors (rejected, D5).** The kinder message on an
  unauthenticated endpoint is an oracle for session existence and guess
  proximity.
- **A long-lived enrollment token per client (rejected).** A credential again,
  with an expiry measured in whatever the operator forgot to set.
- **Let the Core hold client keys and hand them out (rejected, D3).** It is the
  blob with extra steps and it puts a client's private key in a second place.
- **Fail *open* on an unreadable `pairing.json` (rejected, D10).** Serving
  through a corrupt revocation list means honouring certificates an operator
  has already taken back, silently.

## Consequences

Enrollment is now one code, one client, one certificate, and `pair revoke`
takes back exactly one machine without touching the others. Nothing an operator
reads aloud is a secret after five minutes, and nothing in the flow is a secret
both parties hold.

The costs are named rather than mitigated. A Core now completes TLS handshakes
with unverified clients whenever a pre-auth surface is mounted, and the whole
safety of that rests on the gate re-checking per request (D2). CSR parsing —
new third-party code — runs on unauthenticated input (D7). A corrupt
`pairing.json` locks out every paired client (D10). And pairing is now a flow
with more steps than a paste: an operator who cannot run a command on the Core
cannot enroll a client at all, which is a deliberate exchange of convenience
for the removal of a hand-carried key.
