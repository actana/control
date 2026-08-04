import { Modal } from "~/components/ui/Modal";
import { Btn } from "~/components/ui/Btn";
import { openExternal } from "~/lib/open-external";
import { HotkeyTooltip } from "~/components/ui/Tooltip";
import { useHotkey } from "~/lib/use-hotkey";
import { HARNESS_REGISTRY } from "@actana/shared/harnesses";
import type { CliAvailability } from "~/lib/cli-availability";
import type { Harness } from "@actana/shared/domain";

const DEFAULT_UPDATE_COMMANDS = ["Update the CLI to the latest version, then try again."] as const;

export function HarnessUpdateRequiredDialog({
  open,
  agent,
  availability,
  onClose,
}: {
  open: boolean;
  agent: Harness | null;
  availability: CliAvailability | null;
  onClose: () => void;
}) {
  const label = availability?.label ?? (agent ? HARNESS_REGISTRY[agent].label : "Harness CLI");
  const requiredVersion = availability?.requiredVersion ?? "the required version";
  const installedVersion = availability?.version;
  const updateCommands = availability?.updateCommands?.length
    ? availability.updateCommands
    : DEFAULT_UPDATE_COMMANDS;
  const packageUrl = availability?.packageUrl;

  useHotkey("dialog.submit", () => onClose(), { enabled: open });

  const openPackagePage = () => {
    if (!packageUrl) return;
    openExternal(packageUrl);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Update ${label} to ${requiredVersion} or newer`}
      width={540}
      footer={
        <>
          {packageUrl && (
            <Btn variant="ghost" onClick={openPackagePage} icon="external-link">
              Open update page
            </Btn>
          )}
          <HotkeyTooltip action="dialog.submit">
            <Btn variant="primary" icon="check" onClick={onClose}>
              Got it
            </Btn>
          </HotkeyTooltip>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text)" }}>
          Actana Control needs {label} {requiredVersion} or newer before it can start
          this session.
        </div>
        <div
          style={{
            padding: "10px 12px",
            background: "var(--surface-0)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            color: "var(--text-dim)",
            lineHeight: 1.55,
          }}
        >
          {installedVersion
            ? `Installed: ${installedVersion}. Required: ${requiredVersion}.`
            : `Actana Control could not verify ${label} ${requiredVersion} or newer.`}
        </div>
        <div
          style={{
            padding: "10px 12px",
            background: "color-mix(in oklch, var(--accent) 10%, transparent)",
            border: "1px solid color-mix(in oklch, var(--accent) 35%, var(--border))",
            borderRadius: 7,
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            color: "var(--text)",
            lineHeight: 1.55,
          }}
        >
          {updateCommands.map((command, index) => (
            <div key={command}>
              {index > 0 && <br />}
              {command}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
