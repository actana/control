# Core-link authentication and transport security

> _Written before the #33 rename. Read "Harness" as what is now a **Core**, and "agent"/"TaskAgent" as what is now a **Harness**; the wording is left as it was decided._

The core-link uses `wss://` (TLS 1.3) with mutual certificate pinning for identity and confidentiality, and an app-layer bearer token with expiry for session lifetime. A custom crypto protocol (key-pair handshake → derived symmetric key → frame-level encryption) was considered and rejected because it reimplements TLS badly.

## Context

The Panel dials one-or-more Harnesses over a persistent WebSocket. Each connection must provide: (1) mutual identity so a Harness only accepts its Panel and vice-versa, (2) confidentiality for PTY streams and task mutations in transit, (3) bounded session lifetime so a compromised or stale credential is not permanent.

## Decision

- **Transport:** `wss://` with a self-signed CA generated at first Harness install. The Harness holds a server cert, the Panel holds a client cert, both signed by that CA and pinned. The TLS handshake is the key-pair handshake; TLS 1.3's AES-GCM/ChaCha20 is the symmetric encryption.
- **Session layer:** after the mTLS handshake, the Panel presents a signed bearer `{coreId, exp, sig}` in an `auth` frame. The Harness validates `exp`; on expiry the Panel drops the WebSocket, re-handshakes TLS, re-presents a fresh bearer, and reconnects via the `lastEventId` replay path that already exists for Panel-sleep recovery.
- **No rolling renewal.** Token expiry is handled by the same reconnect+replay path that handles laptop sleep and network blips — one code path, no mid-stream token-swap edge cases.

## Considered Options

- **Custom crypto over plain `ws://` (rejected).** Key-pair handshake (X25519 ECDH) → derived session key → AES-GCM frame encryption → signed bearer with `exp`. Reinvents TLS, including nonce management, replay protection, and key rotation — a multi-month, peer-review-tiring effort with no security benefit over TLS.
- **Plain per-Core bearer, no mTLS (rejected).** Matches today's sandbox token but a leaked token equals full shell on the VM. mTLS removes the stealable-token class of risk.

## Consequences

- Harness install generates a self-signed CA + server cert + Panel client cert; the Panel's Core registry stores the client cert + CA alongside the endpoint and alias. Token rotation = re-handshake, not a new subsystem.
- The existing `ws` client in `sandbox-agent-client.ts` (which already accepts `ca`/`cert`/`key`) is extended from optional self-signed pinning to mandatory mTLS.
- Bearer issuance/validation is ~50 lines of app-layer code on top of TLS; the `auth`/`renew` frame types are added to the generalized core-link schema.
- The reconnect-on-expiry path is the *same* path as reconnect-on-sleep, so no new recovery logic — `lastEventId` replay covers both.
