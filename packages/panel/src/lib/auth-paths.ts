/** The Panel's anonymous pages — the whole of what an unauthenticated browser sees. */
export const LOGIN_PATH = "/login";
export const SETUP_PATH = "/setup";

export function isAuthPath(pathname: string): boolean {
  return pathname === LOGIN_PATH || pathname === SETUP_PATH;
}
