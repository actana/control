import { createFileRoute } from "@tanstack/react-router";
import { FleetView } from "~/components/views/FleetView";

// Home route. The Fleet view (see FleetView.tsx) is the Panel's landing surface
// — a live union of every registered Core's sessions, grouped by owning Core.
// Clicking a Session opens that Core's workspace (`/cores/$coreId/workspace`).
export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return <FleetView />;
}
