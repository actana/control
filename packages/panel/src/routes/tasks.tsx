import { createFileRoute } from "@tanstack/react-router";
import { TasksView } from "~/components/views/TasksView";

// `?task=<id>` opens that Task's detail on the board, so a link from a file or a comment can land on it.
function validateTasksSearch(search: Record<string, unknown>): { task?: string } {
  return typeof search.task === "string" && search.task ? { task: search.task } : {};
}

// The Tasks board across every Core (issue 571, screen 06).
export const Route = createFileRoute("/tasks")({
  validateSearch: validateTasksSearch,
  component: TasksRoutePage,
});

function TasksRoutePage() {
  const { task } = Route.useSearch();
  return <TasksView openTaskId={task ?? null} />;
}
