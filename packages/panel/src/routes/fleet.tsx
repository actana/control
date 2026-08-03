import { createFileRoute } from "@tanstack/react-router";
import { FleetView } from "~/components/views/FleetView";

// Fleet view (issue 07) — a live, non-persisted Panel view that fans out
// `tasks.list` to every connected Core in parallel and merges results keyed by
// `coreId/taskId`. Offline Cores show "unreachable + last-seen" with no task
// rows. Degenerates to per-Core navigation when only one Core is registered.
export const Route = createFileRoute("/fleet")({
  component: FleetRoutePage,
});

function FleetRoutePage() {
  return <FleetView />;
}
