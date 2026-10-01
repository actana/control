import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";
import { Btn } from "~/components/ui/Btn";
import { CardFrame } from "~/components/ui/CardFrame";
import { EmptyState } from "~/components/ui/EmptyState";
import { Section } from "~/components/ui/Section";
import { Icon } from "~/components/ui/Icon";
import { CursorGlow } from "~/components/ui/CursorGlow";
import { CoreNeedsUpdateNotice } from "~/components/views/CoreNeedsUpdate";
import { formatRelativeTime } from "~/lib/format-relative-time";
import { FleetSessionRow } from "~/components/views/FleetSessionRow";
import { useFleet } from "~/lib/fleet-context";
import { setSelectedCoreId as writeSelectedCoreId } from "~/lib/selected-core-store";
import { OPEN_SETTINGS_EVENT } from "~/lib/design-meta";
import { coreOrder, type CoreWithDial } from "~/shared/cores";

// Fleet view — a live, non-persisted dashboard. `sessionRowsList` fans out to every
// registered Core over this tab's one panel link and the answers merge keyed by
// `coreId/sessionId`. An unreachable Core shows its state and last-seen with no
// session rows: the Panel caches nothing session-shaped, so a downed Core is honestly
// blank rather than stale.
//
// Clicking a row opens the Session; picking a Core opens that Core's page
// (`/cores/$coreId`). Fleet hosts no drill of its own.

export function FleetView() {
  const router = useRouter();
  const { fleet, cores, loading, error, refresh } = useFleet();

  const openCore = useCallback(
    (coreId: string, tab?: "sessions") => {
      writeSelectedCoreId(coreId);
      void router.navigate({ to: "/cores/$coreId", params: { coreId }, search: tab ? { tab } : {} });
    },
    [router],
  );
  // A Session opens in that Core's workspace (issue 560) — no /projects/$id.
  const openSession = useCallback(
    (coreId: string, _projectId: string) => {
      void router.navigate({ to: "/cores/$coreId/workspace", params: { coreId } });
    },
    [router],
  );
  // Pairing lives in Settings > Cores; this is the Fleet's way in.
  const pairCore = useCallback(() => {
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { panel: "cores" } }));
  }, []);

  return (
    <>
      <CursorGlow />
      <div style={{ flex: 1, overflow: "auto" }} className="dot-grid-bg">
        <CardFrame style={{ width: "100%", minHeight: "100%", padding: 8 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              margin: "-8px -8px 28px",
              gap: 24,
              flexWrap: "wrap",
              padding: "28px 24px 24px",
            }}
          >
            <div>
              <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" }}>
                Fleet
              </h1>
              <div style={{ marginTop: 4, fontSize: 14, color: "var(--text-dim)" }}>
                {`${fleet.rows.length} active ${fleet.rows.length === 1 ? "session" : "sessions"} across ${cores.length} ${cores.length === 1 ? "Core" : "Cores"}`}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <CorePicker cores={cores} onPick={(core) => openCore(core.id)} />
              <Btn variant="ghost" icon="plus" onClick={pairCore}>
                Pair a Core
              </Btn>
              <Btn variant="ghost" icon="refresh" onClick={refresh}>
                Refresh
              </Btn>
            </div>
          </div>

          {cores.length === 0 ? (
            <EmptyState
              title="Add your first Core"
              subtitle="A Core is a machine running the Core. Install it there, run `actana pair new` on it, and pair it with this Panel using the code it prints to see its sessions here."
              icon="grid"
            />
          ) : error ? (
            <EmptyState
              title="Could not load the fleet"
              subtitle={error}
              icon="shield"
              action={
                <Btn variant="primary" icon="refresh" onClick={refresh}>
                  Retry
                </Btn>
              }
            />
          ) : (
            <FleetDashboard
              loading={loading}
              cores={cores}
              fleetRows={fleet.rows}
              onOpenCore={openCore}
              onOpenSession={openSession}
            />
          )}
        </CardFrame>
      </div>
    </>
  );
}

// ─── Fleet dashboard ────────────────────────────────────────────────────────

// Every registered Core gets a section, whether or not it has work in it. A
// Core with no sessions and a Core the Panel cannot reach are different facts,
// and a dashboard that renders only the Cores with rows would show them the
// same way — as nothing at all.
function FleetDashboard({
  loading,
  cores,
  fleetRows,
  onOpenCore,
  onOpenSession,
}: {
  loading: boolean;
  cores: CoreWithDial[];
  fleetRows: ReturnType<typeof useFleet>["fleet"]["rows"];
  onOpenCore: (coreId: string) => void;
  onOpenSession: (coreId: string, projectId: string) => void;
}) {
  if (loading && fleetRows.length === 0) {
    return (
      <EmptyState
        title="Loading fleet"
        subtitle="Asking every registered Core for its sessions…"
        icon="sparkles"
      />
    );
  }

  const rowsByCore = new Map<string, typeof fleetRows>();
  for (const row of fleetRows) {
    const bucket = rowsByCore.get(row.coreId);
    if (bucket) bucket.push(row);
    else rowsByCore.set(row.coreId, [row]);
  }

  return (
    <>
      {cores.map((core) => {
        const rows = rowsByCore.get(core.id) ?? [];
        return (
          <Section
            key={core.id}
            label={core.label}
            count={rows.length}
            icon="globe"
            divider={false}
            marginBottom={32}
            labelSize={13}
          >
            <div data-core-section={core.id}>
            <Btn variant="ghost" size="sm" icon="chevron-right" onClick={() => onOpenCore(core.id)}>
              Open {core.label}
            </Btn>
            <CoreDialLine dial={core.dial} />
            {core.dial.state === "needs-update" ? (
              // No rows, no "no active sessions": a Core whose protocol this
              // Panel doesn't speak has nothing true to say about its work, so
              // the chore stands in place of the data (ADR 0005).
              <CoreNeedsUpdateNotice dial={core.dial} />
            ) : rows.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {rows.map((row) => (
                  <FleetSessionRow
                    key={`${row.coreId}/${row.sessionId}`}
                    row={row}
                    onOpen={() => onOpenSession(row.coreId, row.projectId)}
                  />
                ))}
              </div>
            ) : (
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-faint)" }}>
                {core.dial.state === "connected" ? "no active sessions" : "no sessions to show"}
              </div>
            )}
            </div>
          </Section>
        );
      })}
    </>
  );
}

// The Core's link, in one line. `connected` says nothing extra — the rows below
// are the evidence. Every other state owes the operator a reason and a
// last-seen, because what is (or isn't) below is then not the Core's fault.
function CoreDialLine({ dial }: { dial: CoreWithDial["dial"] }) {
  if (dial.state === "connected") return null;
  // `needs-update` gets the notice below instead — one statement of the fact,
  // with the command attached, rather than a status word above a status box.
  if (dial.state === "needs-update") return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 10,
        fontFamily: "var(--mono)",
        fontSize: 11,
        color: "var(--text-dim)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dial.state === "connecting" ? "var(--text-dim)" : "var(--text-faint)",
          flexShrink: 0,
        }}
      />
      <span>{dial.state}</span>
      <span style={{ color: "var(--text-faint)" }}>
        {dial.lastSeenAt ? `· last seen ${formatRelativeTime(dial.lastSeenAt)}` : "· never seen"}
      </span>
      {dial.detail && <span style={{ color: "var(--text-faint)" }}>· {dial.detail}</span>}
    </div>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

// CorePicker: pick a Core to jump to its page. The picker doesn't hold a
// selection — every change fires `onPick` and navigates.
function CorePicker({
  cores,
  onPick,
}: {
  cores: CoreWithDial[];
  onPick: (core: CoreWithDial) => void;
}) {
  const sorted = [...cores].sort(coreOrder);
  return (
    <div className="mc-input-frame" style={{ display: "flex", alignItems: "center", padding: "0 12px", height: 36 }}>
      <Icon name="globe" size={12} style={{ color: "var(--text-faint)", marginRight: 6 }} />
      <select
        value=""
        onChange={(e) => {
          const core = cores.find((c) => c.id === e.target.value);
          if (core) onPick(core);
        }}
        aria-label="Open a Core"
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: 0,
          outline: 0,
          color: "var(--text)",
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          cursor: "pointer",
        }}
      >
        <option value="" disabled>
          Open a Core…
        </option>
        {sorted.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
            {c.dial.state === "connected" ? "" : ` (${c.dial.state})`}
          </option>
        ))}
      </select>
    </div>
  );
}
