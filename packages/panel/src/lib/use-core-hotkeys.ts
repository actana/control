import { useEffect } from "react";
import { coreForHotkey } from "~/lib/core-rail";
import { matchAnyPinnedSlot } from "~/lib/keybindings/match";
import { useBinding } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";

/**
 * ⌘1 to ⌘9 jump to the Nth Core in rail order. Capture phase: a focused xterm
 * textarea swallows the key on bubble. A digit past the last Core is still
 * consumed, so it never falls through to the browser's tab switching.
 */
export function useCoreHotkeys(
  cores: readonly CoreWithDial[],
  openCore: (coreId: string) => void,
): void {
  const base = useBinding("project.pinnedSlot");
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const slot = matchAnyPinnedSlot(e, base);
      if (slot == null) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const core = coreForHotkey(cores, slot);
      if (core) openCore(core.id);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [base, cores, openCore]);
}
