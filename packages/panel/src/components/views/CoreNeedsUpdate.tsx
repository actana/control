import { useState } from "react";
import { Icon } from "~/components/ui/Icon";
import { CORE_UPDATE_COMMAND, coreDriftDirection, type CoreDialStatus } from "~/shared/cores";

// "This Core needs updating", as an operator-facing chore.
//
// The Panel carries no feature detection (ADR 0005), so a Core speaking another
// core-link protocol has exactly one thing to say and one thing to offer: which
// versions drifted, and the command that closes the gap. It is a copy button
// rather than prose because the command is going to be pasted into a terminal
// on a different machine — usually from a phone or a second laptop, which is
// the whole point of the Panel being a web service.
//
// **The command has to leave the daemon running the new version**, or the
// button is decoration: the Core would keep announcing the old protocol and
// this notice would keep saying the same thing. `CORE_UPDATE_COMMAND`'s
// docstring says which command does that and which two do not.
//
// Everything else about the Core — its projects, sessions, terminals — is
// suppressed at the panel-link router, so this notice stands where that data
// would have been rather than beside it.

export function CoreNeedsUpdateNotice({
  dial,
  compact = false,
}: {
  dial: CoreDialStatus;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  // Which side is behind decides what the operator is told to do. A Panel that
  // has not been upgraded while its fleet has is the same gate in the other
  // direction, and handing over the Core installer there fixes nothing.
  const panelBehind = coreDriftDirection(dial) === "panel-behind";

  const copy = () => {
    void navigator.clipboard?.writeText(CORE_UPDATE_COMMAND).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: compact ? "8px 10px" : "12px 14px",
        marginBottom: 10,
        background: "var(--surface-0)",
        border: "1px solid color-mix(in srgb, var(--warning) 40%, var(--border))",
        borderRadius: 7,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Icon name="shield" size={12} style={{ color: "var(--warning)" }} />
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: "var(--warning)",
          }}
        >
          Needs update
        </span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
          core-link {dial.coreVersion ?? "unknown"} · this Panel speaks{" "}
          {dial.panelVersion ?? "a newer protocol"}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>
        {panelBehind
          ? "This Core is ahead of this Panel. Its sessions stay hidden until the Panel itself is upgraded — pull a newer Panel and restart it."
          : "Its sessions stay hidden until the Core on that machine is updated. Run this there — it lands the new version, restarts the daemon, and keeps the pairing:"}
      </div>
      {!panelBehind && (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          background: "var(--surface-1)",
          border: "1px solid var(--border)",
          borderRadius: 5,
        }}
      >
        <code
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text)",
            overflowX: "auto",
            whiteSpace: "pre",
          }}
        >
          {CORE_UPDATE_COMMAND}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy the update command"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 7px",
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-dim)",
            fontFamily: "var(--mono)",
            fontSize: 10,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={11} />
          {copied ? "copied" : "copy"}
        </button>
      </div>
      )}
    </div>
  );
}
