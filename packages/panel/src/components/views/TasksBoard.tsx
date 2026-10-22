import { useEffect, useId, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Btn } from "~/components/ui/Btn";
import { EmptyState } from "~/components/ui/EmptyState";
import { api } from "~/lib/api";
import { useFleet } from "~/lib/fleet-context";
import { queryKeys, useCoreAgents, useTasks } from "~/queries";
import { BOARD_COLUMNS, columnTasks, taskCountsByCore, tasksForCore } from "~/lib/task-board";
import { acceptsDrop, boardColumnOf, dropDecision, type BoardColumnId } from "~/lib/task-board-drop";
import { useBoardDrag, type TaskCardDrag } from "~/lib/use-board-drag";
import { Z_INDEX } from "~/lib/z-index";
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
  drag,
}: {
  task: TaskDto;
  coreLabel: string | null;
  onOpen: (id: string) => void;
  onReply: (id: string) => void;
  drag: TaskCardDrag;
}) {
  const { data: agents } = useCoreAgents(task.coreId ?? "");
  const agent = agents?.find((a) => a.id === task.agent);
  return <TaskCard task={task} coreLabel={coreLabel} agentLabel={agent?.name ?? null} onOpen={onOpen} onReply={onReply} drag={drag} />;
}

const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** How a column looks while a card is carried: its own, one it may go to, or one it may not. */
type DropState = "origin" | "allowed" | "refused";

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

  // Dragging a card to another column (#827) makes the same one call as the
  // Assign / Back to draft buttons, and a re-assign makes it too: Comment &
  // re-assign refuses an empty comment. The card moves at once and goes back
  // if the server says no.
  const queryClient = useQueryClient();
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  // The card to put focus back on once it shows in that column (after a keyboard or pointer move).
  const [refocus, setRefocus] = useState<{ id: string; column: BoardColumnId } | null>(null);
  const hintId = useId();
  const move = useMutation({
    mutationFn: ({ task, to }: { task: TaskDto; to: "assigned" | "draft" }) => api.setTaskStatus(task.id, to),
    onMutate: async ({ task, to }) => {
      setMoving((s) => new Set(s).add(task.id));
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks, exact: true });
      const prev = queryClient.getQueryData<TaskDto[]>(queryKeys.tasks);
      queryClient.setQueryData<TaskDto[]>(queryKeys.tasks, (cur) =>
        cur?.map((t) => (t.id === task.id ? { ...t, status: to, updatedAt: Date.now() } : t)),
      );
      return { prev };
    },
    onError: (err, { task }, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(queryKeys.tasks, ctx.prev);
      // The optimistic render already used up the refocus; the rollback is a new element again.
      setRefocus({ id: task.id, column: boardColumnOf(task.status) });
      const message = err instanceof Error ? err.message : String(err);
      setAnnouncement(`Not moved. ${message}`);
      toast.error(message);
    },
    onSettled: (_data, _err, { task }) => {
      setMoving((s) => {
        const next = new Set(s);
        next.delete(task.id);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
  const labelOfColumn = (id: BoardColumnId) => BOARD_COLUMNS.find((c) => c.id === id)?.label ?? id;
  const commitDrop = (task: TaskDto, target: BoardColumnId) => {
    const d = dropDecision(task, target);
    if (d.kind === "noop") {
      setAnnouncement("Cancelled.");
      return;
    }
    if (d.kind === "refuse") {
      setAnnouncement(`${labelOfColumn(target)}: not allowed. ${d.reason}`);
      toast.error(d.reason);
      return;
    }
    setAnnouncement(`Moved to ${labelOfColumn(target)}.`);
    setRefocus({ id: task.id, column: target });
    move.mutate({ task, to: d.to });
  };
  const { drag, cardDrag, ghostRef, boardRef, cancel } = useBoardDrag({ onDrop: commitDrop, announce: setAnnouncement, describedBy: hintId });
  // The poll can move (or remove) the card being carried: the pick-up no longer holds, so drop it.
  useEffect(() => {
    if (!drag) return;
    const live = tasks.find((t) => t.id === drag.task.id);
    if (live && boardColumnOf(live.status) === boardColumnOf(drag.task.status)) return;
    cancel();
    if (!live) {
      setAnnouncement(`Cancelled: ${drag.task.title} is gone.`);
      return;
    }
    const column = boardColumnOf(live.status);
    setAnnouncement(`Cancelled: ${drag.task.title} is now in ${labelOfColumn(column)}.`);
    setRefocus({ id: live.id, column });
  }, [tasks, drag]);
  // A moved card is a new element in its new column: put focus back on it.
  useEffect(() => {
    if (!refocus) return;
    // Gone, or filtered out by a chip: it will not show, so do not wait to pull focus later.
    if (!visible.some((t) => t.id === refocus.id)) {
      setRefocus(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(
      `[data-board-column="${refocus.column}"] [data-task-card="${refocus.id.replace(/["\\]/g, "\\$&")}"]`,
    );
    if (!el) return;
    // Only if focus is still on the board's side of things: not if it went to a dialog.
    if (document.activeElement !== el && (document.activeElement === document.body || document.activeElement === null)) el.focus();
    setRefocus(null);
  }, [refocus, visible]);
  const dropStateOf = (col: BoardColumnId): DropState | undefined => {
    if (!drag) return undefined;
    if (boardColumnOf(drag.task.status) === col) return "origin";
    return acceptsDrop(drag.task, col) ? "allowed" : "refused";
  };

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
        <div ref={boardRef} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, alignItems: "start" }}>
          {BOARD_COLUMNS.map((col) => {
            const items = columnTasks(visible, col.statuses);
            const dropState = dropStateOf(col.id);
            const over = drag?.over === col.id;
            const refusal = dropState === "refused" && over && drag ? dropDecision(drag.task, col.id) : null;
            return (
              <section
                key={col.id}
                aria-label={col.label}
                data-board-column={col.id}
                data-drop-state={dropState}
                data-drop-over={over ? "true" : undefined}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  padding: 12,
                  borderRadius: 12,
                  background: dropState === "allowed" ? "var(--accent-subtle-bg)" : "var(--surface-1)",
                  minHeight: 160,
                  // Dashed where it may land, solid on the one it would land in now.
                  outline: dropState === "allowed" ? `2px ${over ? "solid" : "dashed"} var(--brand-accent)` : undefined,
                  outlineOffset: -2,
                  opacity: dropState === "refused" ? 0.55 : undefined,
                }}
              >
                <header style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: col.color }} />
                  {col.label}
                  <span style={{ color: "var(--text-dim)" }}>{items.length}</span>
                  {dropState === "refused" ? <span style={{ marginLeft: "auto", color: "var(--error)", letterSpacing: 0, textTransform: "none" }}>Not allowed</span> : null}
                </header>
                {refusal?.kind === "refuse" ? <div style={{ fontSize: 12, color: "var(--error)" }}>{refusal.reason}</div> : null}
                {items.map((t) => (
                  <CardWithAgent
                    key={t.id}
                    task={t}
                    coreLabel={labelOf(t.coreId)}
                    onOpen={(id) => setOpen({ id, reply: false })}
                    onReply={(id) => setOpen({ id, reply: true })}
                    drag={cardDrag(t, moving.has(t.id))}
                  />
                ))}
              </section>
            );
          })}
        </div>
      )}
      <p id={hintId} style={visuallyHidden}>
        Enter opens the Task. Space picks it up to move it: arrow keys choose a column, Space or Enter drops it there, Escape cancels.
      </p>
      <div role="status" aria-live="polite" style={visuallyHidden}>
        {announcement}
      </div>
      {drag?.via === "pointer" ? (
        <div
          ref={ghostRef}
          aria-hidden
          style={{
            position: "fixed",
            left: 0,
            top: 0,
            zIndex: Z_INDEX.popover,
            pointerEvents: "none",
            padding: 12,
            borderRadius: 10,
            border: "1px solid var(--brand-accent)",
            background: "var(--surface-card)",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {drag.task.title}
        </div>
      ) : null}
      <NewTaskDialog open={creating} onClose={() => setCreating(false)} initialCoreId={coreId ?? chip} onCreated={(id) => setOpen({ id, reply: false })} />
      {open ? <TaskDetail taskId={open.id} focusComposer={open.reply} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
