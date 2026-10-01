import { createFileRoute } from "@tanstack/react-router";
import { CorePage } from "~/components/views/CorePage";
import type { CoreTab } from "~/components/views/CoreHeader";

// A Core's page. `?tab=` picks Sessions (the default), Files or Tasks. Hand-
// rolled validation, to keep zod out of the eager chunk.
function validateCoreSearch(search: Record<string, unknown>): { tab?: CoreTab } {
  const raw = search.tab;
  return raw === "files" || raw === "tasks" || raw === "sessions" ? { tab: raw } : {};
}

export const Route = createFileRoute("/cores/$coreId")({
  validateSearch: validateCoreSearch,
  component: CoreRoutePage,
});

function CoreRoutePage() {
  const { coreId } = Route.useParams();
  const { tab } = Route.useSearch();
  return <CorePage coreId={coreId} tab={tab ?? "sessions"} />;
}
