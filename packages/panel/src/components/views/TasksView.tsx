import { CardFrame } from "~/components/ui/CardFrame";
import { TasksBoard } from "~/components/views/TasksBoard";
import { useIsCompact } from "~/lib/breakpoint";

const INTRO = "Work items stored in the Panel (Postgres) · assigned to an Agent on a Core · results come back as files";

/** The Tasks page (screen 06): every Task across Cores, with a filter per Core. */
export function TasksView({ openTaskId = null }: { openTaskId?: string | null }) {
  // Phone and tablet (M40): the top bar names the page, so only the intro line stays.
  if (useIsCompact()) {
    return (
      <div className="mc-tasks-page">
        <p className="mc-tasks-intro">{INTRO}</p>
        <TasksBoard openTaskId={openTaskId} />
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflow: "auto" }} className="dot-grid-bg">
      <CardFrame style={{ width: "100%", minHeight: "100%", padding: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Tasks</h1>
        <p style={{ margin: "8px 0 20px", color: "var(--text-dim)", fontFamily: "var(--mono)", fontSize: 13 }}>{INTRO}</p>
        <TasksBoard openTaskId={openTaskId} />
      </CardFrame>
    </div>
  );
}
