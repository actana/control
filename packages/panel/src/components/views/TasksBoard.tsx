import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Lock } from "lucide-react";
import { toast } from "sonner";
import { Btn } from "~/components/ui/Btn";
import { EmptyState } from "~/components/ui/EmptyState";
import { Icon } from "~/components/ui/Icon";
import { api } from "~/lib/api";
import { useBreakpoint } from "~/lib/breakpoint";
import { useFleet } from "~/lib/fleet-context";
import { queryKeys, useCoreAgents, useTasks } from "~/queries";
import { BOARD_COLUMNS, columnTasks, taskCountsByCore, tasksForCore } from "~/lib/task-board";
import { acceptsDrop, boardColumnOf, DROP_REASONS, dropDecision, type BoardColumnId } from "~/lib/task-board-drop";
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
  compact,
  placeholder,
}: {
  task: TaskDto;
  coreLabel: string | null;
  onOpen: (id: string) => void;
  onReply: (id: string) => void;
  drag: TaskCardDrag;
  compact: boolean;
  placeholder: boolean;
}) {
  const { data: agents } = useCoreAgents(task.coreId ?? "");
  const agent = agents?.find((a) => a.id === task.agent);
  return <TaskCard task={task} coreLabel={coreLabel} agentLabel={agent?.name ?? null} onOpen={onOpen} onReply={onReply} drag={drag} compact={compact} placeholder={placeholder} />;
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

/** Column names on the segmented control and the phone header: the desktop "Finished · Partial · Failed" is too long. */
const SHORT_LABEL: Record<BoardColumnId, string> = { draft: "Draft", assigned: "Assigned", in_progress: "In progress", finished: "Finished" };

/** Why a column refuses the carried card, short enough for a drop target (M41); DROP_REASONS stays the toast's detail. */
const SHORT_REASONS: Record<keyof typeof DROP_REASONS, string> = {
  onlyPanelStarts: "Only the Panel starts a Task",
  resultFilesDecide: "Only a result finishes a Task",
  runningStopFirst: "Stop it first, then re-assign",
  needsCoreAndAgent: "Needs a Core and an Agent",
  draftNotRun: "Only a result finishes a Task",
  assignedNotRun: "Only a result finishes a Task",
  finishedNotDraft: "A finished Task can’t go back to draft",
};
const shortReason = (reason: string) => {
  const key = (Object.keys(DROP_REASONS) as (keyof typeof DROP_REASONS)[]).find((k) => DROP_REASONS[k] === reason);
  return key ? SHORT_REASONS[key] : reason;
};

/** From this width up the board shows two columns, as on a tablet: a 744 px frame is "phone" by breakpoint (see mobile-shell.css, #831). */
const TWO_UP_QUERY = "(min-width: 600px)";
const subscribeTwoUp = (onChange: () => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const list = window.matchMedia(TWO_UP_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
};
const twoUpNow = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(TWO_UP_QUERY).matches;

/** A horizontal swipe on the column list: at least this far, and clearly more sideways than down. */
const SWIPE_MIN_PX = 50;

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
  // Phone and tablet show the columns a few at a time (M40): `page` is the first of them.
  const breakpoint = useBreakpoint();
  const compact = breakpoint !== "desktop";
  const wide = useSyncExternalStore(subscribeTwoUp, twoUpNow, () => false);
  // Two columns from 600 px up (tablet and the 744 px frame), one below.
  const single = compact && !wide;
  const [page, setPage] = useState(0);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
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
      if (compact) toast.error(`Can’t move to ${SHORT_LABEL[target]}`, { description: d.reason });
      else toast.error(d.reason);
      return;
    }
    setAnnouncement(`Moved to ${labelOfColumn(target)}.`);
    setRefocus({ id: task.id, column: target });
    move.mutate({ task, to: d.to });
  };
  const { drag, cardDrag, ghostRef, boardRef, cancel } = useBoardDrag({ onDrop: commitDrop, announce: setAnnouncement, describedBy: hintId });
  // A long press that lifted a card is a drag, not a swipe.
  useEffect(() => {
    if (drag) swipeStart.current = null;
  }, [drag]);
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
    // On a phone the column it went to may not be the one showing; its card is not there to focus.
    if (!el && compact) {
      setRefocus(null);
      return;
    }
    if (!el) return;
    // Only if focus is still on the board's side of things: not if it went to a dialog.
    if (document.activeElement !== el && (document.activeElement === document.body || document.activeElement === null)) el.focus();
    setRefocus(null);
  }, [refocus, visible, compact]);
  const dropStateOf = (col: BoardColumnId): DropState | undefined => {
    if (!drag) return undefined;
    if (boardColumnOf(drag.task.status) === col) return "origin";
    return acceptsDrop(drag.task, col) ? "allowed" : "refused";
  };


  // The columns on show: all four on desktop; on a phone the selected one, on a tablet it and the next.
  const perPage = single ? 1 : 2;
  const first = compact ? Math.min(page, BOARD_COLUMNS.length - perPage) : 0;
  const shown = compact ? BOARD_COLUMNS.slice(first, first + perPage) : BOARD_COLUMNS;
  const countOf = (statuses: (typeof BOARD_COLUMNS)[number]["statuses"]) => columnTasks(visible, statuses).length;
  // While a card is carried by pointer the segments become the drop targets, and the list below stops being one.
  const dropGrid = compact && drag?.via === "pointer";
  const onSwipeEnd = (e: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    const end = e.changedTouches[0];
    if (!start || !end || drag) return;
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    setPage((p) => Math.min(BOARD_COLUMNS.length - 1, Math.max(0, Math.min(p, BOARD_COLUMNS.length - perPage) + (dx < 0 ? 1 : -1))));
  };
  const dropHint = (col: BoardColumnId, state: DropState | undefined) => {
    if (!drag || state === "origin") return "From here";
    const d = dropDecision(drag.task, col);
    if (d.kind === "refuse") return shortReason(d.reason);
    return d.kind === "draft" ? "Release to move to Draft" : "Release to assign";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {coreId ? (
          <div />
        ) : (
          <div role="group" aria-label="Filter by Core" className={compact ? "mc-tasks-chips" : undefined} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
        {compact ? null : (
          <Btn variant="primary" icon="plus" onClick={() => setCreating(true)}>
            New Task
          </Btn>
        )}
      </div>
      {compact ? (
        dropGrid && drag ? (
          <>
            <p className="mc-tasks-drop-help">Drop on a column to move the Task. Let go anywhere else to cancel.</p>
            <div className="mc-tasks-drop-grid">
              {BOARD_COLUMNS.map((col) => {
                const state = dropStateOf(col.id);
                return (
                  <div
                    key={col.id}
                    data-board-column={col.id}
                    data-drop-state={state}
                    data-drop-over={drag.over === col.id ? "true" : undefined}
                    className="mc-tasks-drop-target"
                  >
                    <div className="mc-tasks-drop-title">
                      {state === "origin" ? <ArrowUp size={14} aria-hidden /> : null}
                      {state === "allowed" ? <Icon name="check" size={14} /> : null}
                      {state === "refused" ? <Lock size={14} aria-hidden /> : null}
                      {SHORT_LABEL[col.id]} <span>{countOf(col.statuses)}</span>
                    </div>
                    <div className="mc-tasks-drop-hint">{dropHint(col.id, state)}</div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div role="tablist" aria-label="Board column" className="mc-tasks-segments">
            {BOARD_COLUMNS.map((col, i) => {
              const selected = i >= first && i < first + perPage;
              return (
                <button
                  key={col.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="mc-tasks-segment"
                  onClick={() => setPage(i)}
                >
                  <span>{SHORT_LABEL[col.id]}</span>
                  <span className="mc-tasks-segment-count">{countOf(col.statuses)}</span>
                </button>
              );
            })}
          </div>
        )
      ) : null}
      {error ? (
        <EmptyState title="Could not load Tasks" subtitle={error instanceof Error ? error.message : String(error)} icon="shield" />
      ) : isLoading ? null : (
        <div
          ref={boardRef}
          className={compact ? "mc-tasks-columns" : undefined}
          data-columns={compact ? perPage : undefined}
          onTouchStart={
            compact
              ? (e) => {
                  const t = e.touches[0];
                  swipeStart.current = t ? { x: t.clientX, y: t.clientY } : null;
                }
              : undefined
          }
          onTouchEnd={compact ? onSwipeEnd : undefined}
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, alignItems: "start" }}
        >
          {shown.map((col) => {
            const items = columnTasks(visible, col.statuses);
            // On a phone or tablet the drop targets are the segments (M41), not the list.
            const dropState = compact ? undefined : dropStateOf(col.id);
            const over = !compact && drag?.over === col.id;
            const refusal = dropState === "refused" && over && drag ? dropDecision(drag.task, col.id) : null;
            return (
              <section
                key={col.id}
                aria-label={col.label}
                data-board-column={dropGrid ? undefined : col.id}
                data-drop-state={dropState}
                data-drop-over={over ? "true" : undefined}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  padding: single ? 0 : 12,
                  borderRadius: 12,
                  background: single ? "transparent" : dropState === "allowed" ? "var(--accent-subtle-bg)" : "var(--surface-1)",
                  minHeight: single ? undefined : 160,
                  // Dashed where it may land, solid on the one it would land in now.
                  outline: dropState === "allowed" ? `2px ${over ? "solid" : "dashed"} var(--brand-accent)` : undefined,
                  outlineOffset: -2,
                  opacity: dropState === "refused" ? 0.55 : undefined,
                }}
              >
                <header style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: col.color }} />
                  {compact ? SHORT_LABEL[col.id] : col.label}
                  <span style={{ color: "var(--text-dim)" }}>{items.length}</span>
                  {single ? (
                    <span aria-hidden className="mc-tasks-pager">
                      {BOARD_COLUMNS.map((c) => (
                        <i key={c.id} data-current={c.id === col.id ? "true" : undefined} />
                      ))}
                      <small>swipe</small>
                    </span>
                  ) : null}
                  {dropState === "refused" ? <span style={{ marginLeft: "auto", color: "var(--error)", letterSpacing: 0, textTransform: "none" }}>Not allowed</span> : null}
                </header>
                {refusal?.kind === "refuse" ? <div style={{ fontSize: 12, color: "var(--error)" }}>{refusal.reason}</div> : null}
                {compact && items.length === 0 ? <div className="mc-tasks-empty">No Tasks in {SHORT_LABEL[col.id]}.</div> : null}
                {items.map((t) => (
                  <CardWithAgent
                    key={t.id}
                    task={t}
                    coreLabel={labelOf(t.coreId)}
                    onOpen={(id) => setOpen({ id, reply: false })}
                    onReply={(id) => setOpen({ id, reply: true })}
                    drag={cardDrag(t, moving.has(t.id))}
                    compact={compact}
                    placeholder={compact && drag?.via === "pointer" && drag.task.id === t.id}
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
      {compact ? (
        <button type="button" className="mc-tasks-fab" data-tabbar={coreId ? "true" : undefined} onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} />
          New Task
        </button>
      ) : null}
      <NewTaskDialog open={creating} onClose={() => setCreating(false)} initialCoreId={coreId ?? chip} onCreated={(id) => setOpen({ id, reply: false })} />
      {open ? <TaskDetail taskId={open.id} focusComposer={open.reply} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
