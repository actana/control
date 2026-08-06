# Observability

The Panel service and each Core both log to stdout/stderr, so whoever
supervises the process owns the sink:

| How you run it | Where the logs are |
| --- | --- |
| Compose / Docker | `docker compose logs panel`, `docker compose logs core` |
| systemd user unit (Linux Core) | `journalctl --user -u actana-core` |
| LaunchAgent (macOS Core) | the paths `actana status` prints |
| Foreground (`pnpm start`) | the terminal you started it in |

`actana status` on a Core prints where its own daemon logs land, along with the
Core's address, its bearer token, and whether a newer release exists.

There is no metrics endpoint and no tracing exporter. The Panel holds no
task-shaped state to report on — each Core owns its own
([ADR 0004](adr/0004-core-owns-write-path.md)) — so the useful signal is the
process log plus `actana status` on the machine in question.

## See also

- [Driving Actana Control from another tool](external-api.md)
- [`../INSTALL.md#troubleshooting`](../INSTALL.md#troubleshooting) — an install that went wrong
