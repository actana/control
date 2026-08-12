# Spike #151 — Node 22 mTLS and `fetch` findings

Throwaway. Nothing in `packages/` imports any of this, and no dependency was
added to the workspace. Delete `experiment/` once D12 is settled.

Companion script: [`spike-151-node22-mtls.mjs`](spike-151-node22-mtls.mjs).

## Verdict on D12

**D12 stands. `engines: ">=22"` is correct — keep it.**

Both connections succeed on Node 22 with the CA, client certificate and client
key read from a registration blob, against a live Core. Node 24 was run as the
control and produced byte-identical results. Nothing fails on 22 that passes on
24, so there is no decision to escalate and extraction is not blocked.

| Leg | Node 22.23.2 | Node 24.19.0 |
| --- | --- | --- |
| 1 — `ws` reaches `ready` | PASS | PASS |
| 1b — bearer `auth` → `authOk` | PASS | PASS |
| 2a — `fetch` completes mutual TLS | PASS | PASS |
| 2b — `fetch` without a client cert is refused | PASS | PASS |
| 2c — `fetch` gets an HTTP response over mTLS | PASS | PASS |
| 3 — wrong host fails SAN validation | PASS | PASS |

## The trap, confirmed

`fetch` is undici. It ignores `options.cert` / `options.key` — there is no
option bag on `fetch` that reaches TLS at all. The only seam is the `dispatcher`
option, and the certificate goes into the dispatcher's `connect` block:

```js
import { Agent } from "undici";

const agent = new Agent({ connect: { ca, cert, key } });
await fetch(url, { dispatcher: agent });
```

Leg 2b is what makes leg 2a mean anything. The same `fetch` through an `Agent`
built as `new Agent({ connect: { ca } })` — CA only, no client cert — is refused
by the Core at the TLS layer (`UND_ERR_SOCKET: other side closed`), because the
Core sets `requestCert: true, rejectUnauthorized: true`. Without that control, a
passing leg 2a would be indistinguishable from a server that never asked.

## Correction to the `experiment/action.md` §5 trap

Two notes, because the ticket's summary of §5 is half right and the wrong half
costs debugging time.

1. **`experiment/action.md` does not exist** anywhere in this repo or its
   history. §5 could not be read; the claim was tested directly instead.
2. **X.509 binds hosts, not ports.** The Core's server certificate carries
   `CN=127.0.0.1` with SAN `IP Address:127.0.0.1, DNS:localhost`. There is no
   port anywhere in a certificate, and no TLS stack checks one.
   - Dialling the **same Core on a different port** validates fine. Leg 2c
     proves it: that listener presents the Core's own server certificate on an
     ephemeral port and `fetch` accepts it.
   - Dialling the **same Core on a different host** fails, and this is the real
     trap: `https://172.17.0.2:9444` (the container's own address, same socket)
     fails with `ERR_TLS_CERT_ALTNAME_INVALID`.

   So "a rewritten port mapping fails validation" is true in practice only
   because rewriting the mapping usually changes the **host** the Panel dials.
   Fix the host, not the port. Neither has anything to do with the Node version.

## The Core serves no HTTP route on its mTLS port

Worth recording because it shaped how leg 2 had to be built, and it is a fact
about the Core rather than about Node.

`pty-core-link-server.ts` builds the mTLS listener as `https.createServer(opts)`
with **no request listener** and attaches a `WebSocketServer` to it. That port
answers WebSocket upgrades and nothing else. A plain `GET https://127.0.0.1:9444/`
— from `fetch`, from `curl`, from anything — hangs until the client gives up.
`docs/external-api.md` says the same thing from the other direction: the Core's
only HTTP surface is the loopback hook receiver, which is plain HTTP on an
ephemeral port and not TLS at all.

That is why leg 2 splits in two:

- **2a** dials the live Core and asserts on the `TLSSocket` itself
  (`authorized === true`, peer `CN=127.0.0.1`, own cert `CN=mission-control-panel`,
  TLSv1.3) rather than on a status code. The handshake is the thing under test;
  the subsequent HTTP timeout is the Core having no route, not a TLS failure.
- **2c** gets an actual `HTTP 200` through the same `Agent` by standing up a
  throwaway loopback listener using the **Core's own** server certificate, CA and
  `requestCert: true, rejectUnauthorized: true` gate. Same credentials, same
  trust chain, plus a route to answer on.

If a later ticket needs `fetch` against a real Core HTTP route, that route does
not exist yet and someone has to add it. The transport shape is proven; the
surface is not there.

## Two smaller things that will bite

- **`ws` takes the classic options directly.** `new WebSocket(url, {ca, cert, key})`
  works because `ws` hands the bag to `https.request`. This is exactly the
  asymmetry the ticket flagged: the same credentials go in two different ways
  depending on which client you are holding.
- **Do not set `servername` when the blob's endpoint is an IP.** RFC 6066
  forbids an IP literal in SNI. Node 22 warns (`DEP0123`) and says it will start
  ignoring it. Node matches the SAN `IP Address` entry against the dialled
  address without SNI, so just omit it — set `servername` only for a DNS host.

## Reproducing

`ws` and `undici` are deliberately **not** in the workspace. Install them into a
scratch directory outside the repo and point `SPIKE_MODULES` at it:

```sh
mkdir -p /tmp/spike-rig && cd /tmp/spike-rig && npm init -y && npm i undici@7 ws@8
cd /path/to/worktree
SPIKE_MODULES=/tmp/spike-rig/node_modules node experiment/spike-151-node22-mtls.mjs
```

Needs a live Core and its registration blob (default
`~/.config/actana/registration-blob.txt`). Leg 2c additionally reads
`~/.config/actana/material.json` for the Core's server certificate. Exit status
is 0 only when every leg passes.
