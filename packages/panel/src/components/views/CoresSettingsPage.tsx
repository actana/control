import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Btn } from "~/components/ui/Btn";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Textarea } from "~/components/ui/Textarea";
import { Field, SettingsSection } from "~/components/views/SettingsParts";
import { CoreNeedsUpdateNotice } from "~/components/views/CoreNeedsUpdate";
import { api } from "~/lib/api";
import { formatRelativeTime } from "~/lib/format-relative-time";
import { coreOrder, type CoreDialStatus, type CoreWithDial } from "~/shared/cores";

/**
 * Cores settings — the operator's view of the fleet, and the one place a Core
 * is paired or forgotten.
 *
 * The link state shown here belongs to the Panel *service*: it dials every Core
 * whether or not this page is open, so all this page does is poll for the
 * service's answer rather than hold connections of its own. Closing the tab
 * costs the fleet nothing.
 */

/** How often to re-ask the service for link state. */
const DIAL_POLL_MS = 3_000;

export function CoresSettingsPage() {
  const [cores, setCores] = useState<CoreWithDial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [registrationBlob, setRegistrationBlob] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const [pendingRemoval, setPendingRemoval] = useState<CoreWithDial | null>(null);
  const [removing, setRemoving] = useState(false);

  // A poll that lands after unmount must not write to a dead component.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { cores: next } = await api.listCores();
      if (!mounted.current) return;
      setCores([...next].sort(coreOrder));
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), DIAL_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleRegister = async () => {
    const blob = registrationBlob.trim();
    if (!blob) return;
    setRegistering(true);
    setRegisterError(null);
    try {
      const { core } = await api.addCore(blob);
      setRegistrationBlob("");
      await refresh();
      toast.success(`Core "${core.label}" paired.`);
    } catch (err) {
      // Inline rather than a toast: a rejected paste is something the operator
      // has to correct in the box that is still in front of them.
      setRegisterError(err instanceof Error ? err.message : "Could not pair that Core.");
    } finally {
      setRegistering(false);
    }
  };

  const handleRemove = async () => {
    const core = pendingRemoval;
    if (!core) return;
    setRemoving(true);
    try {
      await api.removeCore(core.id);
      setPendingRemoval(null);
      await refresh();
      toast.success(`Core "${core.label}" removed.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove Core.");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <SettingsSection
      title="Cores"
      subtitle="The machines this Panel manages. Pair one by pasting the token its Core printed at install; the Panel keeps the link up from the server, so your fleet stays connected with no browser open. Credentials are encrypted in the Panel's data directory."
      headingLevel="h1"
    >
      {loading ? (
        <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)" }}>
          loading…
        </div>
      ) : (
        <>
          {error && <ErrorBox>{error}</ErrorBox>}

          <Field label="Registered Cores">
            {cores.length === 0 ? (
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  color: "var(--text-dim)",
                  padding: "12px 14px",
                  background: "var(--surface-0)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                }}
              >
                No Cores yet. Install the Core on a machine and paste the token it prints below.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {cores.map((core) => (
                  <CoreRow
                    key={core.id}
                    core={core}
                    onRemove={() => setPendingRemoval(core)}
                    removing={removing && pendingRemoval?.id === core.id}
                  />
                ))}
              </div>
            )}
          </Field>

          <Field label="Add a Core">
            <div
              style={{
                padding: "14px 16px",
                background: "var(--surface-0)",
                border: "1px solid var(--border)",
                borderRadius: 7,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)" }}>
                Run <code>core install</code> on the machine and paste the single line it prints.
                It carries the endpoint, the pinned CA and client certificate, and the signed bearer
                — everything the Panel needs to dial that Core, and nothing it can reach without.
              </div>
              <Textarea
                label="Pairing token"
                value={registrationBlob}
                onChange={(v) => {
                  setRegistrationBlob(v);
                  if (registerError) setRegisterError(null);
                }}
                placeholder="paste the pairing token here…"
                rows={3}
                mono
                disabled={registering}
              />
              {registerError && <ErrorBox>{registerError}</ErrorBox>}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Btn
                  variant="primary"
                  size="sm"
                  icon="plus"
                  onClick={handleRegister}
                  disabled={registering || !registrationBlob.trim()}
                >
                  {registering ? "Pairing…" : "Add Core"}
                </Btn>
              </div>
            </div>
          </Field>
        </>
      )}

      <ConfirmDialog
        open={pendingRemoval !== null}
        onClose={() => setPendingRemoval(null)}
        onConfirm={handleRemove}
        title={`Remove ${pendingRemoval?.label ?? "Core"}?`}
        confirmLabel="Remove Core"
        loading={removing}
      >
        The Panel stops dialing this Core and forgets its credentials and its place in the event
        log. Nothing on the machine itself is touched — its projects, tasks, and running sessions
        keep going. To manage it again you&apos;ll need a fresh pairing token.
      </ConfirmDialog>
    </SettingsSection>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        fontFamily: "var(--mono)",
        fontSize: 12,
        color: "var(--danger, #e5484d)",
        padding: "8px 12px",
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
        borderRadius: 7,
      }}
    >
      {children}
    </div>
  );
}

function CoreRow({
  core,
  onRemove,
  removing,
}: {
  core: CoreWithDial;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "12px 14px",
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
        borderRadius: 7,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 3,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{core.label}</span>
          <DialBadge dial={core.dial} />
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            color: "var(--text-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {core.endpoint}
          {core.dial.state !== "connected" && core.dial.lastSeenAt !== null && (
            <> · last seen {formatRelativeTime(core.dial.lastSeenAt)}</>
          )}
        </div>
      </div>
      <Btn
        variant="ghost"
        size="sm"
        icon={removing ? undefined : "trash"}
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove Core ${core.label}`}
      >
        {removing ? "Removing…" : "Remove"}
      </Btn>
    </div>
      {/* The chore, where the operator manages Cores: the command that closes
          the version gap, one click from the clipboard. */}
      {core.dial.state === "needs-update" && (
        <div style={{ marginTop: 8 }}>
          <CoreNeedsUpdateNotice dial={core.dial} compact />
        </div>
      )}
    </div>
  );
}

/** The Core's link state, as the service last reported it. */
function DialBadge({ dial }: { dial: CoreDialStatus }) {
  const { label, color } = badgeStyle(dial);
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color,
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        padding: "2px 6px",
      }}
      title={badgeTitle(dial)}
    >
      {label}
    </span>
  );
}

function badgeStyle(dial: CoreDialStatus): { label: string; color: string } {
  switch (dial.state) {
    case "connected":
      return { label: "Connected", color: "var(--accent-ink)" };
    case "connecting":
      return { label: "Connecting", color: "var(--text-dim)" };
    case "unreachable":
      return { label: "Unreachable", color: "var(--text-dim)" };
    case "auth-error":
      return { label: "Needs pairing", color: "var(--danger, #e5484d)" };
    case "needs-update":
      return { label: "Needs update", color: "var(--warning, #f5a524)" };
  }
}

function badgeTitle(dial: CoreDialStatus): string {
  const lastSeen =
    dial.lastSeenAt === null ? "never reached" : `last seen ${formatRelativeTime(dial.lastSeenAt)}`;
  switch (dial.state) {
    case "connected":
      return "mTLS handshake and bearer accepted — frames are flowing.";
    case "connecting":
      return `Dialing this Core (${lastSeen}).`;
    case "unreachable":
      return `${dial.detail ?? "The Panel can't reach this Core"} — ${lastSeen}. It keeps retrying.`;
    case "auth-error":
      return `This Core rejected the Panel's credentials (${dial.detail ?? "rejected"}). Reissue a pairing token on the machine and add it again.`;
    case "needs-update":
      return `${dial.detail ?? "This Core speaks a different core-link protocol"}. Its data is suppressed until the Core on that machine is updated.`;
  }
}
