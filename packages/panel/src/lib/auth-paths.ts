/** The Panel's anonymous pages — the whole of what an unauthenticated browser sees. */
export const LOGIN_PATH = "/login";
export const SETUP_PATH = "/setup";

export function isAuthPath(pathname: string): boolean {
  return pathname === LOGIN_PATH || pathname === SETUP_PATH;
}

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
 */
export function withCarriedQuery(pathname: string, search: string): string {
  const query = new URLSearchParams(search).toString();
  return query ? `${pathname}?${query}` : pathname;
}
