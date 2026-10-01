import { CardFrame } from "~/components/ui/CardFrame";
import { TasksBoard } from "~/components/views/TasksBoard";

/** The Tasks page (screen 06): every Task across Cores, with a filter per Core. */
export function TasksView() {
  return (
    <div style={{ flex: 1, overflow: "auto" }} className="dot-grid-bg">
      <CardFrame style={{ width: "100%", minHeight: "100%", padding: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Tasks</h1>
        <p style={{ margin: "8px 0 20px", color: "var(--text-dim)", fontFamily: "var(--mono)", fontSize: 13 }}>
          Work items stored in the Panel (Postgres) · assigned to an Agent on a Core · results come back as files
        </p>
        <TasksBoard />
      </CardFrame>
    </div>
  );
}
