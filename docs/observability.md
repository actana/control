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

## Log lines worth grepping for

A Core says something when a Session's status is decided by something other
than the harness reporting it (issue 243). All of them are ordinary log lines —
there is no counter endpoint to scrape:

| Line | What it means |
| --- | --- |
| `hook-delivery.missed` | a hook's POST never got an ack; the line names the task, the event and curl's exit |
| `hook-delivery.missed-total` | how many drops this Core has seen since boot — one a week is a flake, forty in an hour is a Core losing to its own load |
| `session-sweep.settled` | rows a Core restart stranded, marked `disconnected` at boot |
| `session-backstop.settled` | a Session settled because its turn went quiet and no `Stop` ever arrived |

The drops are recorded by the hook itself into
`<user-data-dir>/hook-misses.log` and drained into the log from there, so the
ones that happened while the Core was down show up on its next boot. See
[harness status detection](harness-status-detection.md#delivery-and-what-happens-when-there-is-none).

There is no metrics endpoint and no tracing exporter. The Panel holds no
task-shaped state to report on — each Core owns its own
([ADR 0004](adr/0004-core-owns-write-path.md)) — so the useful signal is the
process log plus `actana status` on the machine in question.

## See also

- [Driving Actana Control from another tool](external-api.md)
- [`../INSTALL.md#troubleshooting`](../INSTALL.md#troubleshooting) — an install that went wrong
