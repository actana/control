import type { FormEvent, ReactNode } from "react";
import { Btn } from "~/components/ui/Btn";
import { useIsPhone } from "~/lib/breakpoint";

/**
 * The chrome shared by the two anonymous pages. Deliberately self-contained —
 * it renders outside the app shell (see __root.tsx), so it can't lean on any
 * provider, query, or Core being reachable.
 */
export function AuthCard({
  title,
  subtitle,
  error,
  submitLabel,
  busy,
  onSubmit,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  error: string | null;
  submitLabel: string;
  busy: boolean;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const isPhone = useIsPhone();
  return (
    <div
      data-auth-page
      style={
        isPhone
          ? {
              // Phone: the document scrolls (mobile-shell.css), so with the
              // keyboard up the submit button can still be scrolled to. The
              // card centres with auto margins, which give way to the top edge
              // instead of pushing the card off it the way align-items does.
              minHeight: "100dvh",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              background: "var(--bg)",
              padding: 16,
            }
          : {
              minHeight: "100vh",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg)",
              padding: 24,
            }
      }
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: "100%",
          maxWidth: isPhone ? undefined : 380,
          margin: isPhone ? "auto 0" : undefined,
          boxSizing: isPhone ? "border-box" : undefined,
          background: "var(--surface-card)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "var(--shadow-card)",
          padding: isPhone ? 24 : 28,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)" }}>{title}</h1>
          <p style={{ fontSize: isPhone ? 13 : 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{subtitle}</p>
        </div>
        {children}
        {error && (
          <div role="alert" style={{ fontSize: isPhone ? 13 : 12, color: "var(--text-error)" }}>
            {error}
          </div>
        )}
        <Btn type="submit" variant="primary" size="lg" disabled={busy}>
          {busy ? "Working…" : submitLabel}
        </Btn>
        {footer}
      </form>
    </div>
  );
}
