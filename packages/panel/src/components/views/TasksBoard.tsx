import { useEffect, useMemo, useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { EmptyState } from "~/components/ui/EmptyState";
import { useFleet } from "~/lib/fleet-context";
import { useCoreAgents, useTasks } from "~/queries";
import { BOARD_COLUMNS, columnTasks, taskCountsByCore, tasksForCore } from "~/lib/task-board";
import { TaskCard } from "~/components/views/TaskCard";
import { NewTaskDialog } from "~/components/views/NewTaskDialog";
import { TaskDetail } from "~/components/views/TaskDetail";
import type { TaskDto } from "~/shared/task-wire";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        fontFamily: "var(--mono)",
        fontSize: 13,
        padding: "6px 14px",
        borderRadius: 999,
        border: `1px solid ${active ? "var(--brand-accent)" : "var(--border)"}`,
        background: active ? "var(--accent-subtle-bg)" : "transparent",
        color: "inherit",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function CardWithAgent({
  task,
  coreLabel,
  onOpen,
  onReply,
}: {
  task: TaskDto;
  coreLabel: string | null;
  onOpen: (id: string) => void;
  onReply: (id: string) => void;
}) {
  const { data: agents } = useCoreAgents(task.coreId ?? "");
  const agent = agents?.find((a) => a.id === task.agent);
  return <TaskCard task={task} coreLabel={coreLabel} agentLabel={agent?.name ?? null} onOpen={onOpen} onReply={onReply} />;
}

/**
 * The Tasks board (screen 06): columns by status, filter chips per Core.
 * With `coreId` it is the same board filtered to that Core and the chips go
 * away (the Core page's Tasks tab). Status only ever comes from the server.
 */
export function TasksBoard({ coreId = null, openTaskId = null }: { coreId?: string | null; openTaskId?: string | null }) {
  const { cores } = useFleet();
  const { data: tasks = [], isLoading, error } = useTasks();
  const [chip, setChip] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<{ id: string; reply: boolean } | null>(openTaskId ? { id: openTaskId, reply: false } : null);
  // A link to another Task while the board is already open.
  useEffect(() => {
    if (openTaskId) setOpen({ id: openTaskId, reply: false });
  }, [openTaskId]);
  const filter = coreId ?? chip;
  const visible = useMemo(() => tasksForCore(tasks, filter), [tasks, filter]);
  const counts = useMemo(() => taskCountsByCore(tasks), [tasks]);
  const labelOf = (id: string | null) => (id ? (cores.find((c) => c.id === id)?.label ?? null) : null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {coreId ? (
          <div />
        ) : (
          <div role="group" aria-label="Filter by Core" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Chip active={chip === null} onClick={() => setChip(null)}>
              All Cores <small>{tasks.length}</small>
            </Chip>
            {cores.map((c) => (
              <Chip key={c.id} active={chip === c.id} onClick={() => setChip(c.id)}>
                {c.label} <small>{counts.get(c.id) ?? 0}</small>
              </Chip>
            ))}
          </div>
        )}
        <Btn variant="primary" icon="plus" onClick={() => setCreating(true)}>
          New Task
        </Btn>
      </div>
      {error ? (
        <EmptyState title="Could not load Tasks" subtitle={error instanceof Error ? error.message : String(error)} icon="shield" />
      ) : isLoading ? null : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, alignItems: "start" }}>
          {BOARD_COLUMNS.map((col) => {
            const items = columnTasks(visible, col.statuses);
            return (
              <section key={col.id} aria-label={col.label} data-board-column={col.id} style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12, borderRadius: 12, background: "var(--surface-1)", minHeight: 160 }}>
                <header style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: col.color }} />
                  {col.label}
                  <span style={{ color: "var(--text-dim)" }}>{items.length}</span>
                </header>
                {items.map((t) => (
                  <CardWithAgent
                    key={t.id}
                    task={t}
                    coreLabel={labelOf(t.coreId)}
                    onOpen={(id) => setOpen({ id, reply: false })}
                    onReply={(id) => setOpen({ id, reply: true })}
                  />
                ))}
              </section>
            );
          })}
        </div>
      )}
      <NewTaskDialog open={creating} onClose={() => setCreating(false)} initialCoreId={coreId ?? chip} onCreated={(id) => setOpen({ id, reply: false })} />
      {open ? <TaskDetail taskId={open.id} focusComposer={open.reply} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
