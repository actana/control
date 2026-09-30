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
   | `SEAWEEDFS_OIDC_ISSUER` | The `iss` of the tokens the Panel signs. |
   | `SEAWEEDFS_OIDC_JWKS_URL` | Where SeaweedFS fetches the Panel's public keys. Must be reachable from the container. |
   | `SEAWEEDFS_OIDC_AUDIENCE` | The `aud` those tokens carry (default `actana-shared`). |
   | `SEAWEEDFS_BUCKET`, `SEAWEEDFS_PREFIX` | Where the Cores' folders live (default `actana-shared` and `cores`). |

2. `docker compose --profile seaweedfs up -d`. The S3 endpoint is
   `http://localhost:8333` on the host (loopback only) and `http://seaweedfs:8333`
   on the compose network. Put a TLS proxy in front before exposing it.

Nothing secret is committed: the template holds `@@…@@` slots, and the
entrypoint fills them from the environment into `/run/seaweedfs/iam.json`
(mode 0400, owned by the `seaweed` user, inside the container only).

## The image

`chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`

An exact version and its digest, never `latest`. The digest is the multi-arch
image index for the `4.48` tag, read from the Docker Hub registry
(`docker-content-digest` of `GET /v2/chrislusf/seaweedfs/manifests/4.48`, and
the same value in the Hub tags API), against release `4.48` of
`seaweedfs/seaweedfs` published 2026-09-28. Dependabot's `docker` ecosystem
already watches `deploy/` and moves this pin like the other two
([`docs/ci-cd.md`](../../docs/ci-cd.md)).

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
| `ListOwnPrefixOnly` | `ListBucket`, `ListBucketMultipartUploads` | `arn:aws:s3:::BUCKET`, only when `s3:prefix` is `PREFIX/${jwt:sub}` or `PREFIX/${jwt:sub}/*` |
| `KeepTheSessionValid` | `sts:ValidateSession` | `*` (the session itself; SeaweedFS's own test configs grant it to every role) |

`policy.defaultEffect` is `Deny`, so anything not allowed is refused. With
`BUCKET=actana-shared`, `PREFIX=cores` and a Core `core-a`:

| Request | Result | Why |
| --- | --- | --- |
| `PutObject cores/core-a/notes/todo.md` | allowed | under `arn:…:actana-shared/cores/core-a/*` |
| `GetObject` / `DeleteObject cores/core-a/x` | allowed | same resource |
| `ListBucket prefix=cores/core-a/` (or `cores/core-a`) | allowed | `s3:prefix` matches the condition |
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
  `/` or `..`. The list condition uses `StringLike`, so a wildcard in `sub`
  would widen it.
- The Panel is the only holder of the token signer, so whoever can sign a token
  can name any Core. That is the trust this issue asks for.

## Known gaps

This is part 1 of #566 (steps 1 and 2). Not done here, and not claimed:

- **Step 3, SeaweedFS as the default in Settings › Storage (screen 08).** Later
  part of [#566](https://github.com/actana/control/issues/566).
- **The isolation checklist of [#562](https://github.com/actana/control/issues/562)**
  (machine A cannot list, read or write machine B's prefix, key refresh during an
  upload, a Core paused over an hour, no readable key on disk). It has not been
  run against this: the Core mount (#562) does not exist yet.
- **The Panel's key issuer**
  ([actana/client#5](https://github.com/actana/client/issues/5)) and the
  Panel's token signer with a JWKS endpoint: nothing in the Panel publishes an
  issuer or JWKS URL today, so `SEAWEEDFS_OIDC_*` has nothing to point at yet.
- **Not run against a live SeaweedFS.** The config was written from the
  SeaweedFS 4.48 source and its own IAM test configs; no container was started
  for this change.
