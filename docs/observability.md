# Observability

The Panel service and each Core both log to stdout/stderr, so whoever
supervises the process owns the sink:

| How you run it | Where the logs are |
| --- | --- |
| Compose / Docker | `docker compose logs panel`, `docker compose logs core` |
| systemd user unit (Linux Core) | `journalctl --user -u actana-core` |
| LaunchAgent (macOS Core) | `actana logs` tails `~/Library/Logs/Actana/core.log` |
| Foreground (`pnpm start`) | the terminal you started it in |

On any Core, `actana logs` (`-f` to follow) reads the daemon's log wherever it
lands, and `actana status` prints the Core's health, its endpoint, whether a
pairing token is available, and — when one exists — whether a newer release
does too.

There is no metrics endpoint and no tracing exporter. The Panel holds no
task-shaped state to report on — each Core owns its own
([ADR 0004](adr/0004-core-owns-write-path.md)) — so the useful signal is the
process log plus `actana status` on the machine in question.

## See also

- [Driving Actana Control from another tool](external-api.md)
- [`../INSTALL.md#troubleshooting`](../INSTALL.md#troubleshooting) — an install that went wrong
