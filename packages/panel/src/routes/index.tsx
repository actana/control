import { createFileRoute } from "@tanstack/react-router";
import { FleetView } from "~/components/views/FleetView";

// Home route. The Fleet view (see FleetView.tsx) is the Panel's landing surface
// — a live union of every registered Core's sessions, grouped by owning Core.
// The old single-machine projects dashboard was retired when the Panel became
// multi-Core (issue 08 / ADR-0005: one shell across every Core); its content
// is gone from the repo, but the shell UI (per-project sessions, terminals,
// grid views) is reached the same way as before — by clicking through a Fleet
// row into the `/projects/$id` route.
export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return <FleetView />;
}
