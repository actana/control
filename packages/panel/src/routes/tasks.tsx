import { createFileRoute } from "@tanstack/react-router";
import { TasksView } from "~/components/views/TasksView";

// The Tasks board across every Core (issue 571, screen 06).
export const Route = createFileRoute("/tasks")({
  component: TasksView,
});
