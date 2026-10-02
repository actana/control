import { createFileRoute } from "@tanstack/react-router";
import { CorePage } from "~/components/views/CorePage";
import type { CoreTab } from "~/components/views/CoreHeader";

// A Core's page. `?tab=` picks Sessions (the default), Files or Tasks. Hand-
// rolled validation, to keep zod out of the eager chunk.
function validateCoreSearch(search: Record<string, unknown>): { tab?: CoreTab; path?: string } {
  const raw = search.tab;
  const tab = raw === "files" || raw === "tasks" || raw === "sessions" ? raw : undefined;
  // `path` is the Files tab's open folder, relative to the Shared folder. It is only a hint for what to list: the Panel
  // refuses a bad path itself, so a wrong one here shows an error in the tab and does nothing else.
  const path = typeof search.path === "string" && search.path ? search.path : undefined;
  return { ...(tab ? { tab } : {}), ...(path ? { path } : {}) };
}

export const Route = createFileRoute("/cores/$coreId")({
  validateSearch: validateCoreSearch,
  component: CoreRoutePage,
});

function CoreRoutePage() {
  const { coreId } = Route.useParams();
  const { tab, path } = Route.useSearch();
  return <CorePage coreId={coreId} tab={tab ?? "sessions"} path={path ?? ""} />;
}
