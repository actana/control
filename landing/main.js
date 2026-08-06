/*
 * control.actana.ai — the whole script.
 *
 * Two behaviours, no dependencies: the install tabs and the copy buttons.
 * Anything that needs more than this needs its own ADR first
 * (docs/landing-page.md §4).
 */

(() => {
  "use strict";

  /* ------------------------------------------------------------- tabs --- */

  /**
   * Wire one install block. Scoped per block because the page renders two —
   * the hero and the closing CTA — and they switch independently.
   */
  const wireTabs = (group) => {
    const tabs = [...group.querySelectorAll('[role="tab"]')];
    const panels = [...group.querySelectorAll('[role="tabpanel"]')];
    if (tabs.length === 0) return;

    const select = (tab, { focus = false } = {}) => {
      for (const other of tabs) {
        const on = other === tab;
        other.setAttribute("aria-selected", String(on));
        // Roving tabindex: the tablist is one tab stop, arrows move within it.
        other.tabIndex = on ? 0 : -1;
      }
      for (const panel of panels) {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      }
      if (focus) tab.focus();
    };

    for (const tab of tabs) {
      tab.addEventListener("click", () => select(tab));
    }

    group.querySelector('[role="tablist"]').addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      const jump = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (step === undefined && jump === null) return;

      event.preventDefault();
      const from = tabs.indexOf(document.activeElement);
      const next =
        jump !== null ? jump : (((from === -1 ? 0 : from) + step) + tabs.length) % tabs.length;
      select(tabs[next], { focus: true });
    });
  };

  for (const group of document.querySelectorAll("[data-install]")) wireTabs(group);

  /* ------------------------------------------------------------- copy --- */

  /**
   * Copy the command the visitor can see — textContent of the <pre>, so the
   * syntax spans come out as plain shell and the comment travels with it.
   */
  const wireCopy = (button) => {
    const source = button.closest(".codeblock").querySelector("pre");
    let revert;

    button.addEventListener("click", async () => {
      const text = source.textContent.trim();
      let ok = true;

      try {
        // Insecure origins (a plain-HTTP preview) have no clipboard API at all.
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          ok = legacyCopy(text);
        }
      } catch {
        ok = false;
      }

      button.textContent = ok ? "Copied" : "Press ⌘C";
      button.dataset.copied = String(ok);
      if (!ok) selectText(source);

      clearTimeout(revert);
      revert = setTimeout(() => {
        button.textContent = "Copy";
        delete button.dataset.copied;
      }, 2000);
    });
  };

  /** Select the command so a manual copy is one keystroke away. */
  const selectText = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };

  /** execCommand fallback for non-secure contexts. */
  const legacyCopy = (text) => {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.append(scratch);
    scratch.select();

    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    scratch.remove();
    return ok;
  };

  for (const button of document.querySelectorAll("[data-copy]")) wireCopy(button);
})();
