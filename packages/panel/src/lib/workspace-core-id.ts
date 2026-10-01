/** Core id from a pathname under `/cores/:coreId`, or null off Core pages. */
function coreIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/cores\/([^/]+)/)?.[1] ?? null;
}

/**
 * Core id from a Core workspace pathname (`/cores/:coreId/workspace`), or null on
 * any other route. The shell gives the Core's Session panel its Core only here:
 * the Core page itself lists Sessions and has no terminal beside it.
 */
export function workspaceCoreIdFromPath(pathname: string): string | null {
  const core = coreIdFromPath(pathname);
  return core && pathname.includes("/workspace") ? core : null;
}

/**
 * The Core a location is on: the Core page and its workspace name it in the path,
 * and a `coreId` search param names it on any other route that carries one;
 * every other route has none.
 */
export function routeCoreIdFromLocation(location: {
  pathname: string;
  search: unknown;
}): string | null {
  const core = coreIdFromPath(location.pathname);
  if (core) return decodeURIComponent(core);
  const search = location.search as { coreId?: unknown } | undefined;
  return typeof search?.coreId === "string" ? search.coreId : null;
}
