import { useState } from "react";
import { Icon } from "~/components/ui/Icon";
import { Ticked } from "~/components/ui/Ticked";
import { useIsPhone } from "~/lib/breakpoint";
import { CURRENT_MC_VERSION } from "~/queries/mission-control-version";
import { coreUpdatePaths } from "~/shared/core-onboarding";
import {
  coreDriftDirection,
  type CoreDialStatus,
  type CoreUpdatePath,
} from "~/shared/cores";

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
// this notice would keep saying the same thing. `coreUpdatePaths` lists the
// commands that do, one per way a Core gets installed. The Panel cannot see
// which applies to the Core in front of it, so it shows both and says so.
//
// Everything else about the Core — its sessions, terminals — is
// suppressed at the panel-link router, so this notice stands where that data
// would have been rather than beside it.

export function CoreNeedsUpdateNotice({
  dial,
  compact = false,
}: {
  dial: CoreDialStatus;
  compact?: boolean;
}) {
  // Which side is behind decides what the operator is told to do. A Panel that
  // has not been upgraded while its fleet has is the same gate in the other
  // direction, and handing over the Core installer there fixes nothing.
  const panelBehind = coreDriftDirection(dial) === "panel-behind";
  // Phone: body text at 13 px, commands wrap beside a 44 px copy button.
  const isPhone = useIsPhone();

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
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: isPhone ? 12 : 11,
            color: "var(--text-dim)",
            // Phone: stays beside the label and wraps there (M10).
            ...(isPhone ? { flex: "1 1 0", minWidth: 0 } : {}),
          }}
        >
          core-link {dial.coreVersion ?? "unknown"} · this Panel speaks{" "}
          {dial.panelVersion ?? "a newer protocol"}
        </span>
      </div>
      <div style={{ fontSize: isPhone ? 13 : 12, color: "var(--text-dim)", lineHeight: isPhone ? 1.5 : 1.45 }}>
        {panelBehind
          ? "This Core is ahead of this Panel. Its sessions stay hidden until the Panel itself is upgraded — pull a newer Panel and restart it."
          : "Its sessions stay hidden until the Core on that machine is updated. This Panel cannot see how that Core was installed — run the line that matches it. Both keep the pairing:"}
      </div>
      {!panelBehind &&
        coreUpdatePaths(CURRENT_MC_VERSION).map((path) => <CommandRow key={path.id} path={path} />)}
    </div>
  );
}

function CommandRow({ path }: { path: CoreUpdatePath }) {
  const isPhone = useIsPhone();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(path.command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: isPhone ? 13 : 12, color: "var(--text-dim)", lineHeight: isPhone ? 1.5 : 1.45 }}>
        <Ticked text={path.title} />
      </div>
      <div
        data-command-row
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: isPhone ? "8px 8px 8px 12px" : "6px 8px",
          background: "var(--surface-1)",
          border: "1px solid var(--border)",
          borderRadius: 5,
        }}
      >
        <code
          style={
            isPhone
              ? {
                  flex: 1,
                  minWidth: 0,
                  fontFamily: "var(--mono)",
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "var(--text)",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }
              : {
                  flex: 1,
                  minWidth: 0,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--text)",
                  overflowX: "auto",
                  whiteSpace: "pre",
                }
          }
        >
          {path.command}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy the ${path.copyLabel} update command`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: isPhone ? "0 12px" : "3px 7px",
            minHeight: isPhone ? 44 : undefined,
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: isPhone ? 6 : 4,
            color: "var(--text-dim)",
            fontFamily: "var(--mono)",
            fontSize: isPhone ? 12 : 10,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={isPhone ? 12 : 11} />
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {path.note && (
        <div style={{ fontSize: isPhone ? 12 : 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
          <Ticked text={path.note} />
        </div>
      )}
    </div>
  );
}
