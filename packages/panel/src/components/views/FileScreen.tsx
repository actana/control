import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { baseName } from "~/shared/shared-files";

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The opened file on a phone (#833, M25): the details pane beside the folder becomes its own screen over the page, Back ·
 * the file's name on top and the body scrolling under it, as Task detail does (#830). Back and Escape go back to the
 * folder. The dialogs it opens (Rename, Move, Delete) stack above it.
 */
export function FileScreen({ path, onBack, children }: { path: string; onBack: () => void; children: ReactNode }) {
  const back = useRef<HTMLButtonElement>(null);
  const screenRef = useRef<HTMLElement>(null);
  // A modal screen: on open focus goes to Back and on close back to the row that opened it (mount only, so a rename or move, which changes the path, does not steal focus).
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    back.current?.focus();
  }, [path]);
  const keepTabInside = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab" || !screenRef.current) return;
    const items = [...screenRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled"));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === screenRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <section
      ref={screenRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`File ${baseName(path)}`}
      data-testid="file-screen"
      onKeyDown={(e) => {
        keepTabInside(e);
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onBack();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 9000, display: "flex", flexDirection: "column", background: "var(--surface-1)", color: "var(--text)" }}
    >
      <header
        style={{ flex: "none", display: "grid", gridTemplateColumns: "44px minmax(0, 1fr) 44px", alignItems: "center", gap: 8, minHeight: "calc(56px + env(safe-area-inset-top))", padding: "env(safe-area-inset-top) 8px 0", borderBottom: "1px solid var(--border)" }}
      >
        <button
          ref={back}
          type="button"
          aria-label="Back"
          onClick={onBack}
          style={{ minWidth: 44, minHeight: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", border: 0, background: "transparent", color: "var(--text)", cursor: "pointer" }}
        >
          <ArrowLeft size={20} aria-hidden />
        </button>
        <div style={{ minWidth: 0, fontFamily: "var(--mono)", fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{baseName(path)}</div>
        <span />
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", paddingBottom: "env(safe-area-inset-bottom)" }}>{children}</div>
    </section>
  );
}
