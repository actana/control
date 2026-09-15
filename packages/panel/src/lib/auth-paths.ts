/** The Panel's anonymous pages — the whole of what an unauthenticated browser sees. */
export const LOGIN_PATH = "/login";
export const SETUP_PATH = "/setup";

export function isAuthPath(pathname: string): boolean {
  return pathname === LOGIN_PATH || pathname === SETUP_PATH;
}

/**
 * Search parameters that belong to one route and mean nothing on any other,
 * with the route prefix that owns each.
 *
 * `coreId` is the Panel's only one today. `routes/projects.$id.tsx` declares it
 * in `validateProjectSearch`, and `__root.tsx` reads it off *every* route with
 * the invariant spelled out above the selector: "Only the /projects/$id route
 * sets `coreId`; every other route implicitly means the Panel's own rows."
 *
 * Carrying it across an expiry would break that invariant rather than restore a
 * link. A sign-in from `/projects/p1?coreId=core-b` ends on `/`, and `/` with a
 * `coreId` is a root route scoped to a remote Core: `__root.tsx` hands it to
 * `UserTerminalPanel`, whose New Terminal button is disabled precisely when
 * there is no `coreId`, and to the ⌘T binding behind it — so a control that is
 * inert on a clean `/` would come back live, pointed at a machine the operator
 * did not navigate to.
 *
 * A stray Core scope on a route that should have none is a shape this codebase
 * has already been burned by: `ProjectBar.tsx` carries a comment saying its
 * fallback to the bar's `coreId` prop "is gone rather than merely unused",
 * because it made an operator's own project look Core-owned (#382 review round
 * 2). Carrying `coreId` home from an expiry would be the same mistake by
 * another route.
 *
 * The pairing query is untouched by this: `step` belongs to no route — the
 * wizard is rendered by `FirstRunGate` over whatever route the operator landed
 * on — so nothing here filters it, and nothing here names it either.
 */
const ROUTE_SCOPED_PARAMS: readonly { readonly name: string; readonly ownedBy: string }[] = [
  { name: "coreId", ownedBy: "/projects/" },
];

/**
 * A destination with the query string the browser arrived with carried onto it.
 *
 * The auth round trip is three hops — the requested page, `/setup` or `/login`,
 * then back — and every one of them used to be built from a bare path, so a URL
 * that said anything in its query said nothing by the time the shell mounted.
 * That is what breaks the documented Compose link: `/?step=redeem` opens the
 * pairing wizard on the install step, because `FirstRunWizard` reads
 * `window.location.search` and by then the search is empty (#406).
 *
 * The query rides the redirect itself rather than a side channel. There is
 * nothing to store, nothing to expire, and nothing left behind for the *next*
 * visit to pick up by mistake: a link opened in one tab cannot decide where a
 * second tab starts, and an abandoned sign-in leaves no residue.
 *
 * **Only the query travels.** The path is always one this module chose, so this
 * cannot become an open redirect — no origin, no host, no path is taken from
 * the request. Re-serialising through `URLSearchParams` is what makes it safe to
 * put in a `Location` header as well as in `location.assign`: the value is
 * re-encoded, so a CR or LF smuggled into the incoming query is escaped rather
 * than sent as a header break.
 *
 * **A parameter is only carried onto a route it means something on.** The path
 * is dropped and the query kept, so an unfiltered carry would land a deep
 * route's parameters on a shallower one — see {@link ROUTE_SCOPED_PARAMS}.
 */
export function withCarriedQuery(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  for (const { name, ownedBy } of ROUTE_SCOPED_PARAMS) {
    if (!pathname.startsWith(ownedBy)) params.delete(name);
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
