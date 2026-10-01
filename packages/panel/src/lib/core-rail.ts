import type { SessionStatus } from "@actana/shared/domain";
import { coreOrder, type CoreWithDial } from "~/shared/cores";
import { CORE_SLOT_COUNT } from "~/lib/keybindings/match";

// The rail lists Cores, nothing else (0.5.0 proposal, screen 01/02). These are
// its pure parts: order, initials, hotkey slots and the per-Core activity
// counts, kept out of the component so each can be tested without a DOM.

/** How many Cores the rail gives a digit to (⌘1 to ⌘9). */
export const CORE_HOTKEY_LIMIT = CORE_SLOT_COUNT;

/** The Cores in rail order: by label, so a refresh never reshuffles the digits. */
export function railCores<T extends CoreWithDial>(cores: readonly T[]): T[] {
  return [...cores].sort(coreOrder);
}

/** The Core a digit addresses, or undefined when the digit is past the last Core. */
export function coreForHotkey<T extends CoreWithDial>(
  cores: readonly T[],
  digit: number,
): T | undefined {
  if (!Number.isInteger(digit) || digit < 1 || digit > CORE_HOTKEY_LIMIT) return undefined;
  return railCores(cores)[digit - 1];
}

/** "workstation-berlin" -> "WB", "gpu" -> "GP": the tile's two letters. */
export function coreInitials(label: string): string {
  const words = label.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** One word for the status pill and the rail: online, offline, or the Core's own problem. */
export type CoreLinkLabel = "online" | "offline" | "connecting" | "needs update" | "auth error";

export function coreLinkLabel(dial: CoreWithDial["dial"]): CoreLinkLabel {
  switch (dial.state) {
    case "connected":
      return "online";
    case "connecting":
      return "connecting";
    case "needs-update":
      return "needs update";
    case "auth-error":
      return "auth error";
    default:
      return "offline";
  }
}

export type CoreActivity = { running: number; needsInput: number; total: number };

/** What the rail's dots and attention badge are drawn from, per Core. */
export function coreActivity(
  rows: readonly { coreId: string; status: SessionStatus | string }[],
  coreId: string,
): CoreActivity {
  let running = 0;
  let needsInput = 0;
  let total = 0;
  for (const row of rows) {
    if (row.coreId !== coreId) continue;
    total += 1;
    if (row.status === "running") running += 1;
    else if (row.status === "needs-input") needsInput += 1;
  }
  return { running, needsInput, total };
}

/** A stable hue per Core, so a tile keeps its colour across reloads and devices. */
export function coreHue(coreId: string): number {
  let h = 0;
  for (let i = 0; i < coreId.length; i += 1) h = (h * 31 + coreId.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** The status pill's words, left to right: link state, version (when the Core told us), Shared folder. */
export function corePillParts(dial: CoreWithDial["dial"]): { link: CoreLinkLabel; version: string | null; shared: string } {
  return {
    link: coreLinkLabel(dial),
    // Only a `needs-update` dial carries the Core's version today; a connected
    // Core's version has no source on the dial yet, so it is left out, not guessed.
    version: dial.coreVersion ?? null,
    // The Shared folder (#557/#565) has no state to read yet.
    shared: "shared —",
  };
}
