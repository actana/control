// The Harness's logger.
//
// The Harness is a plain Node daemon (ADR 0010 — no Electron anywhere in the
// path), so this is console with a tag. Whoever supervises the process —
// systemd, a terminal, the installer's launch agent — owns the sink.

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const log: Logger = {
  info: (...args) => console.log("[harness]", ...args),
  warn: (...args) => console.warn("[harness]", ...args),
  error: (...args) => console.error("[harness]", ...args),
};

export default log;
