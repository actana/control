# Operator identity and Panel auth

Once the Panel is reachable over a network (ADR 0010), "whoever reaches 127.0.0.1 is trusted" stops being an auth model. The open-source Panel is **single-operator**: one password set at first boot, exchanged for a session cookie; no accounts, roles, or permissions. But the **Operator is a first-class domain entity from day one** — every Core belongs to an Operator, and the OSS build simply has exactly one — so identity stays a thin, replaceable gate in front of the registry rather than an assumption smeared through it.

This shape is deliberate for the product split: a future multi-tenant offering (logins, permissions, per-account Cores) will be a **separate closed-source product in a separate repo** that builds on the OSS Panel and replaces the auth gate — the GitLab CE/EE pattern, not a fork and not feature flags. Nothing in the public repo references tenancy, billing, or accounts.

Core secrets (CA/client cert/key/bearer from the Registration blob) lose Electron's `safeStorage` keychain. They are encrypted with an **auto-generated key file stored in the data volume** next to the database, overridable via `AC_SECRETS_KEY` for operators who inject the key from outside. The data volume is the documented trust boundary — the same posture as Grafana or Portainer.

## Considered Options

- **Multi-user accounts in OSS (rejected).** Drags in per-Core visibility, shell-session permissions, and admin UX that would stall the Electron extraction — and duplicates the planned closed product.
- **Derive the secrets key from the operator password (rejected).** Real at-rest encryption, but after any restart the Panel cannot dial a single Core until the operator logs in — killing unattended fleet-watching and background notifications, which are half the point of self-hosting the Panel.
- **Plaintext secrets (rejected).** The key file is admittedly only file-permissions-strength when the attacker has the volume, but it keeps honest processes (backups, log shippers) from trivially reading credentials, and `AC_SECRETS_KEY` gives a real upgrade path.
