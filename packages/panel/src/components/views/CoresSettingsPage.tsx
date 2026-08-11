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

  const [renamingId, setRenamingId] = useState<string | null>(null);

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

  /**
   * Rename a Core. Panel-local and nothing more: the alias is this Panel's name
   * for the machine, so the write lands in the registry and the list re-reads
   * it. The Core is not told, and another Panel paired to it keeps its own name.
   *
   * Returns whether it stuck, so the row only leaves edit mode on a write that
   * landed — a rejected rename keeps the operator's text in front of them.
   */
  const handleRename = async (core: CoreWithDial, label: string): Promise<boolean> => {
    setRenamingId(core.id);
    try {
      const { core: renamed } = await api.renameCore(core.id, label);
      await refresh();
      // Quote what was stored, not what was typed: an operator who emptied the
      // box gets the endpoint host back, and the toast should say so.
      toast.success(`Core renamed to "${renamed.label}".`);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename Core.");
      return false;
    } finally {
      if (mounted.current) setRenamingId(null);
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
                    onRename={(label) => handleRename(core, label)}
                    renaming={renamingId === core.id}
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

/**
 * What the service will fall back to if the alias is saved empty — shown as the
 * placeholder so clearing the box reads as a choice rather than an accident.
 * Mirrors `labelFor` on the server, down to surviving an unparseable endpoint.
 */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname || endpoint;
  } catch {
    return endpoint;
  }
}

/**
 * One Core in the list. The alias is editable in place — it is the only field
 * here that is the Panel's to change, and the operator's read of the fleet
 * depends on it. Endpoint and credentials are what the pairing token said they
 * were; changing those means a fresh token.
 */
function CoreRow({
  core,
  onRemove,
  removing,
  onRename,
  renaming,
}: {
  core: CoreWithDial;
  onRemove: () => void;
  removing: boolean;
  onRename: (label: string) => Promise<boolean>;
  renaming: boolean;
}) {
  // Non-null is the edit mode flag *and* the draft: an empty string is a state
  // the operator can legitimately be in (it saves as the endpoint host), so
  // "editing" can't be `draft !== ""`.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;

  const commit = async () => {
    if (draft === null) return;
    // Nothing to write, and no toast worth showing for it.
    if (draft.trim() === core.label) {
      setDraft(null);
      return;
    }
    if (await onRename(draft)) setDraft(null);
  };

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
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commit();
                else if (e.key === "Escape") setDraft(null);
              }}
              disabled={renaming}
              aria-label={`Name for Core ${core.label}`}
              // The same 120 the service caps at, so the box can't accept
              // characters the registry would silently drop.
              maxLength={120}
              placeholder={endpointHost(core.endpoint)}
              style={{
                flex: 1,
                minWidth: 120,
                background: "var(--surface-1)",
                border: "1px solid var(--accent)",
                borderRadius: 5,
                outline: 0,
                color: "var(--text)",
                padding: "3px 8px",
                fontSize: 13,
                fontWeight: 600,
              }}
            />
          ) : (
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
              {core.label}
            </span>
          )}
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
      {editing ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <Btn variant="accent" size="sm" onClick={() => void commit()} disabled={renaming}>
            {renaming ? "Saving…" : "Save"}
          </Btn>
          <Btn
            variant="ghost"
            size="sm"
            icon="x"
            onClick={() => setDraft(null)}
            disabled={renaming}
            aria-label={`Cancel renaming Core ${core.label}`}
          >
            Cancel
          </Btn>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <Btn
            variant="ghost"
            size="sm"
            icon="pencil"
            onClick={() => setDraft(core.label)}
            disabled={removing}
            aria-label={`Rename Core ${core.label}`}
          >
            Rename
          </Btn>
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
      )}
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
