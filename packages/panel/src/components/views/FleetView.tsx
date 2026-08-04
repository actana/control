import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Btn } from "~/components/ui/Btn";
import { CardFrame } from "~/components/ui/CardFrame";
import { EmptyState } from "~/components/ui/EmptyState";
import { Section } from "~/components/ui/Section";
import { Icon } from "~/components/ui/Icon";
import { CursorGlow } from "~/components/ui/CursorGlow";
import { getPanelBridge } from "~/lib/panel-bridge";
import { CoreNeedsUpdateNotice } from "~/components/views/CoreNeedsUpdate";
import { formatRelativeTime } from "~/lib/format-relative-time";
import { useCoreProjects, useFleetTasks } from "~/lib/use-fleet";
import { setSelectedCoreId as writeSelectedCoreId } from "~/lib/selected-core-store";
import { useAddProject } from "~/lib/add-project-store";
import { coreOrder, type CoreWithDial } from "~/shared/cores";

// Fleet view — a live, non-persisted dashboard. `tasksList` fans out to every
// registered Core over this tab's one panel link and the answers merge keyed by
// `coreId/taskId`. An unreachable Core shows its state and last-seen with no
// task rows: the Panel caches nothing task-shaped, so a downed Core is honestly
// blank rather than stale.
//
// Clicking a row (or picking a Core) navigates *out* of Fleet view into the
// per-Core shell on `/projects/$id?coreId=`. Fleet view hosts no drill of its
// own — the Singular UI invariant (ADR-0005) says the shell is the same
// whichever Core owns the work.

export function FleetView() {
  const bridge = getPanelBridge();
  const router = useRouter();
  const { fleet, cores, loading, error, refresh } = useFleetTasks();
  const addProject = useAddProject();

  // Into the per-Core shell, tagged with the owning Core so SessionGrid /
  // ProjectBar / NewHarnessDialog address their reads and writes at it.
  const openProject = useCallback(
    (coreId: string, projectId: string) => {
      void router.navigate({
        to: "/projects/$id",
        params: { id: projectId },
        search: { coreId },
      });
    },
    [router],
  );

  // Picking a Core in the CorePicker resolves its first project asynchronously
  // and navigates into that Core's shell. Without a project, open the global
  // Add Project dialog scoped to the picked Core (the shell has nothing to
  // mount without a project — landing on an empty route would be a dead end).
  // The shell itself has no Core switcher; switching Cores means returning to
  // Fleet view and picking a different one (ADR-0005 §5).
  const openCoreShell = useCallback(
    async (core: CoreWithDial) => {
      if (!bridge) return;
      writeSelectedCoreId(core.id);
      try {
        const projects = await bridge.listProjects(core.id);
        const first = projects[0];
        if (first) openProject(core.id, first.projectId);
        else addProject.open();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [bridge, openProject, addProject],
  );

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
                {`${fleet.rows.length} active ${fleet.rows.length === 1 ? "task" : "tasks"} across ${cores.length} ${cores.length === 1 ? "Core" : "Cores"}`}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <CorePicker cores={cores} onPick={(core) => void openCoreShell(core)} />
              {/* Global Add Project — the shared dialog reads the last picked
                  Core (selected-core-store) and seeds its Core selector. */}
              <Btn variant="ghost" icon="plus" onClick={() => addProject.open()}>
                Add project
              </Btn>
              <Btn variant="ghost" icon="refresh" onClick={refresh}>
                Refresh
              </Btn>
            </div>
          </div>

          {cores.length === 0 ? (
            <EmptyState
              title="Add your first Core"
              subtitle="A Core is a machine running the Core. Install it there, then pair it with this Panel using its registration blob to see its sessions here."
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
              onOpenProject={openProject}
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
  onOpenProject,
}: {
  loading: boolean;
  cores: CoreWithDial[];
  fleetRows: ReturnType<typeof useFleetTasks>["fleet"]["rows"];
  onOpenProject: (coreId: string, projectId: string) => void;
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
            <CoreDialLine dial={core.dial} />
            {core.dial.state === "needs-update" ? (
              // No rows, no "no active sessions": a Core whose protocol this
              // Panel doesn't speak has nothing true to say about its work, so
              // the chore stands in place of the data (ADR 0005).
              <CoreNeedsUpdateNotice dial={core.dial} />
            ) : rows.length > 0 ? (
              <CoreProjectGroups coreId={core.id} rows={rows} onOpenProject={onOpenProject} />
            ) : (
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-faint)" }}>
                {core.dial.state === "connected" ? "no active sessions" : "no sessions to show"}
              </div>
            )}
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

// Sub-groups a Core's rows by project so the dashboard reads as:
//   Core label
//     Project name
//       Session, Session, …
// Project names come from the Core's own `projectsList` — task snapshots carry
// only `projectId`, so names are resolved here rather than plumbed through the
// fan-out shape. Until a name lands the projectId stands in, so a group is
// never anonymous.
function CoreProjectGroups({
  coreId,
  rows,
  onOpenProject,
}: {
  coreId: string;
  rows: ReturnType<typeof useFleetTasks>["fleet"]["rows"];
  onOpenProject: (coreId: string, projectId: string) => void;
}) {
  const { projects } = useCoreProjects(coreId);
  const nameByProjectId = new Map(projects.map((p) => [p.projectId, p.name]));

  // Preserve the incoming `updatedAt`-desc order per project bucket, and order
  // buckets by their most-recent row's updatedAt so the freshest project
  // surfaces first under the Core.
  const rowsByProject = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = rowsByProject.get(row.projectId);
    if (bucket) bucket.push(row);
    else rowsByProject.set(row.projectId, [row]);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {[...rowsByProject.entries()].map(([projectId, projectRows]) => {
        const projectName = nameByProjectId.get(projectId) ?? projectId;
        return (
          <div key={projectId}>
            <button
              type="button"
              onClick={() => onOpenProject(coreId, projectId)}
              title={`Open ${projectName}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 8,
                padding: "2px 4px",
                background: "transparent",
                border: 0,
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "var(--mono)",
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--text-dim)",
              }}
            >
              <Icon name="folder" size={11} style={{ color: "var(--text-faint)" }} />
              <span>{projectName}</span>
              <span
                style={{
                  fontSize: 10,
                  color: "var(--text-faint)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {projectRows.length}
              </span>
            </button>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {projectRows.map((row) => (
                <FleetTaskRow
                  key={`${row.coreId}/${row.taskId}`}
                  row={row}
                  onOpen={() => onOpenProject(row.coreId, row.projectId)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FleetTaskRow({
  row,
  onOpen,
}: {
  row: { coreId: string; coreLabel: string; taskId: string; projectId: string; title: string; agent: string; status: string; updatedAt: number };
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
        borderRadius: 7,
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
      }}
    >
      <StatusBadge status={row.status} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.title}
          </span>
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
          {row.agent} · {formatRelativeTime(row.updatedAt)}
        </div>
      </div>
      {/* Core label lives on the section heading now — the per-row badge
          would just repeat what's above the group. */}
      <Icon name="chevron-right" size={12} style={{ color: "var(--text-faint)" }} />
    </button>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

// CorePicker: pick a Core to jump into its per-Core shell. The picker doesn't
// hold a selection — every change fires `onPick` and navigates. Keeping it
// stateless matches ADR-0005 §5: "the shell has no in-shell Core switcher" and
// avoids the Fleet view growing a bespoke drill in disguise.
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
        aria-label="Open a Core's shell"
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

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "running"
      ? "var(--accent)"
      : status === "needs-input"
        ? "var(--warning, #f5a524)"
        : status === "done"
          ? "var(--text-faint)"
          : "var(--text-dim)";
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        animation: status === "running" ? "pulse-dot 1.5s ease-in-out infinite" : undefined,
      }}
    />
  );
}

