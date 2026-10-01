/** Core id from a workspace pathname (`/cores/:coreId/...`), or null off Core pages. */
export function coreIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/cores\/([^/]+)/)?.[1] ?? null;
}

/**
 * @deprecated Prefer {@link coreIdFromPath}. Kept as an alias so shell code that
 * once keyed the terminal panel off `/projects/$id` still compiles while the
 * workspace lives under `/cores/$coreId/workspace` (issue 560).
 */
export function projectIdFromPath(pathname: string): string | null {
  const core = coreIdFromPath(pathname);
  if (core) {
    // The workspace route scopes terminals by Core id.
    if (pathname.includes("/workspace")) return core;
    return null;
  }
  return pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;
}
