# SeaweedFS for the Shared folder

The optional storage backend for the Shared folder of our own development
Cores ([#566](https://github.com/actana/control/issues/566), part of
[#552](https://github.com/actana/control/issues/552)): SeaweedFS with its S3
gateway and STS enabled, and one role that confines a Core to its own prefix.

It is **off by default**. It sits behind the `seaweedfs` compose profile, so a
plain `docker compose up -d` neither starts it, pulls its image nor reads any of
its variables.

```
docker compose --profile seaweedfs up -d
```

```
deploy/
├── docker-compose.yml        the `seaweedfs` service (profile: seaweedfs) + seaweedfs-data volume
├── .env.example              SEAWEEDFS_* placeholders, no values
└── seaweedfs/
    ├── entrypoint.sh         validates the variables, renders the template, starts SeaweedFS
    ├── iam.json.tmpl         STS, the Panel as OIDC provider, the role, the policy
    └── README.md             this file
```

## Setting it up

1. Copy `deploy/.env.example` to `deploy/.env` and fill the `SEAWEEDFS_*`
   block. The service refuses to start on an empty or `change-me` value, on a
   signing key shorter than 32 bytes, and on a prefix that is not a plain path.

   | Variable | What it is |
   | --- | --- |
   | `SEAWEEDFS_S3_ADMIN_ACCESS_KEY`, `SEAWEEDFS_S3_ADMIN_SECRET_KEY` | The one static S3 identity, for the Panel's key issuer. Cores never get it. |
   | `SEAWEEDFS_STS_SIGNING_KEY` | Signs SeaweedFS's own STS session tokens. `openssl rand -base64 32`. |
   | `SEAWEEDFS_OIDC_ISSUER` | The `iss` of the tokens the Panel signs. Empty means `http://panel:7420`, the Panel service on the compose network. |
   | `SEAWEEDFS_OIDC_JWKS_URL` | Where SeaweedFS fetches the Panel's public keys. Empty means `http://panel:7420/.well-known/jwks.json`, a route the Panel serves itself. Set it only if the Panel is reached by another address; it must be reachable from the container. |
   | `SEAWEEDFS_OIDC_AUDIENCE` | The `aud` those tokens carry (default `actana-shared`). |
   | `SEAWEEDFS_BUCKET`, `SEAWEEDFS_PREFIX` | Where the Cores' folders live (default `actana-shared` and `cores`). |

   The Panel's key set needs no hosting by hand: `GET /.well-known/jwks.json`
   on the Panel answers without a session with the public half of the key
   Settings › Storage holds (the same `kid` as the tokens it signs, nothing
   private), and with an empty key set until a key is saved. In Settings ›
   Storage use the same issuer as `SEAWEEDFS_OIDC_ISSUER`.

2. `docker compose --profile seaweedfs up -d`. The S3 endpoint is
   `http://localhost:8333` on the host (loopback only) and `http://seaweedfs:8333`
   on the compose network. Put a TLS proxy in front before exposing it.

Nothing secret is committed: the template holds `@@…@@` slots, and the
entrypoint fills them from the environment into `/run/seaweedfs/iam.json`
(mode 0600, owned by the `seaweed` user, inside the container only).

## The image

`chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882`

An exact version and its digest, never `latest`. The digest is the multi-arch
image index for the `4.47` tag, read from the Docker Hub registry
(`docker-content-digest` of `GET /v2/chrislusf/seaweedfs/manifests/4.47`, and
the same value in the Hub tags API), against release `4.47` of
`seaweedfs/seaweedfs` published 2026-09-14, so 16 days old when pinned. Every
flag the service uses (`-ip`, `-ip.bind`, `-filer`, `-s3`, `-s3.port`,
`-s3.ip.bind`, `-s3.port.iceberg`, `-s3.port.lance`, `-s3.iam.config`,
`-s3.iam.readOnly`) exists in 4.47's `weed/command/server.go`.

Nothing reads a compose file by default, so the pin is kept current by a
`docker-compose` entry for `/deploy` in `.github/dependabot.yml` (weekly, with a
7-day cooldown), next to the `docker` entry that moves the two Dockerfile bases.

## What listens where

`weed server` runs the master (9333), volume server (8080), filer (8888) and the
S3 gateway in one process, and none of the first three authenticates anything. A
Core on the compose network must reach the gateway and nothing else, so
`-ip=127.0.0.1 -ip.bind=127.0.0.1` puts everything on the container's loopback
and only `-s3.ip.bind=0.0.0.0` opens the gateway: port 8333 (S3 and STS). Its
gRPC port (18333) shares that bind address and can rewrite identities and
policies, and SeaweedFS leaves it open when no filer signing key is set, so the
entrypoint generates one per start (`WEED_JWT_FILER_SIGNING_KEY`, 32 random
bytes, never written down) and the gRPC calls then need a token only this
process can sign. The Iceberg and Lance ports are off. A test pins all of it.

## How a Core gets its keys

```
Core ── asks the Panel ──▶ Panel signs a token   iss = SEAWEEDFS_OIDC_ISSUER
                                                 aud = SEAWEEDFS_OIDC_AUDIENCE
                                                 sub = <core-id>
Panel ── AssumeRoleWithWebIdentity(role, token) ──▶ SeaweedFS STS
   SeaweedFS verifies the signature against SEAWEEDFS_OIDC_JWKS_URL,
   checks iss and aud, checks the role's trust policy names this provider,
   and returns short-lived S3 keys carrying the token's `sub`.
Core ── S3 with those keys ──▶ SeaweedFS: policy evaluated with ${jwt:sub} = <core-id>
```

The trust is the Panel's token signer and nothing else: one OIDC provider
(`actana-panel`), whose issuer and JWKS URL come from the environment, and one
role, `arn:aws:iam::role/ActanaCoreShared`, whose trust policy allows
`sts:AssumeRoleWithWebIdentity` for that provider only.

## The role and the policy

`ActanaCoreShared` carries the one policy `ActanaCoreOwnPrefix`
(`iam.json.tmpl`), with `BUCKET`, `PREFIX` from the variables and `${jwt:sub}`
resolved by SeaweedFS from the validated token, so the Core cannot choose it:

| Statement | Allows | On |
| --- | --- | --- |
| `ObjectsUnderOwnPrefix` | `GetObject`, `PutObject`, `DeleteObject`, `AbortMultipartUpload`, `ListMultipartUploadParts` | `arn:aws:s3:::BUCKET/PREFIX/${jwt:sub}/*` |
| `ListOwnPrefixOnly` | `ListBucket`, `ListBucketMultipartUploads` | `arn:aws:s3:::BUCKET`, only when `s3:prefix` matches `PREFIX/${jwt:sub}/*`, so the prefix carries the trailing slash |

`policy.defaultEffect` is `Deny`, so anything not allowed is refused. With
`BUCKET=actana-shared`, `PREFIX=cores` and a Core `core-a`:

| Request | Result | Why |
| --- | --- | --- |
| `PutObject cores/core-a/notes/todo.md` | allowed | under `arn:…:actana-shared/cores/core-a/*` |
| `GetObject` / `DeleteObject cores/core-a/x` | allowed | same resource |
| `ListBucket prefix=cores/core-a/` (or a deeper prefix such as `cores/core-a/notes/`) | allowed | `s3:prefix` matches `cores/core-a/*` |
| `ListBucket prefix=cores/core-a` (no slash) | denied | it would also list `cores/core-ab/…` and `cores/core-a-evil/…`; the condition needs the slash |
| `GetObject cores/core-b/x` | denied | another Core's prefix; no statement matches |
| `ListBucket prefix=cores/core-b/` | denied | `s3:prefix` fails the condition |
| `ListBucket` with no prefix, or `prefix=cores/` or `prefix=` | denied | above the Core's prefix; condition fails |
| `PutObject cores/x` or `PutObject other-key` | denied | beside it: not under `cores/core-a/` |
| `PutObject cores/core-a-evil/x` | denied | `…/core-a/*` needs the slash; `core-a-evil` is a different prefix |
| `ListAllMyBuckets`, `CreateBucket`, `DeleteBucket`, bucket policy calls | denied | no statement allows a bucket-level action |
| Another bucket | denied | resources name the one bucket |
| A token from any other issuer, or with another `aud` | no keys at all | the provider only accepts `SEAWEEDFS_OIDC_ISSUER` and `SEAWEEDFS_OIDC_AUDIENCE` |

Two properties the isolation rests on, both for the **Panel's key issuer** to
honour ([actana/client#5](https://github.com/actana/client/issues/5)):

- `sub` must be exactly the Core id, and a Core id must never contain `*`, `?`,
  `/` or `..`. SeaweedFS substitutes `${jwt:sub}` without escaping, and the list
  condition uses `StringLike`, so a wildcard in `sub` would widen it.
- Core ids must be lowercase, or at least unique ignoring case. SeaweedFS
  compares policy resources case-insensitively, so `core-a` can read and write
  `cores/CORE-A/…`: two ids that differ only in case are one Core to it. Nothing
  in this deployment can check that; the issuer has to.
- The Panel is the only holder of the token signer, so whoever can sign a token
  can name any Core. That is the trust this issue asks for.

## Known gaps

This is the compose deploy for #566. Remaining caveats:

- **The isolation checklist of [#562](https://github.com/actana/control/issues/562)**
  runs in CI against this image (`core-shared-seaweedfs` job): machine A cannot
  list, read or write machine B's prefix; Settings › Storage test-connection
  uses the same probe. In that job SeaweedFS reads the Panel's key set from the
  Panel's own `/.well-known/jwks.json` route.
- **Container hardening.** The entrypoint runs as root to hand a file to the
  `seaweed` user, and the service has no `cap_drop`. Dropping all capabilities
  but CHOWN, SETUID, SETGID, DAC_OVERRIDE and FOWNER should work; it needs a live run.
- **SeaweedFS is the default** in Settings › Storage (screen 08). Opting into
  the compose profile is still required for a local gateway.
