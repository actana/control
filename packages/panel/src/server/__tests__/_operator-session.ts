import { createOperator, operatorExists } from "../services/operator";
import { createPanelSession, resolvePanelSession } from "../services/panel-sessions";
import { PANEL_SESSION_COOKIE } from "../panel-auth";

let session: { cookie: string; token: string } | null = null;

/**
 * A logged-in Operator's cookie header, for tests that drive the API the way a
 * browser does. Creates the Operator on first use in whatever database the test
 * file installed (`openPanelTestDb`), and again if a reset emptied it.
 */
export async function operatorSessionCookie(): Promise<string> {
  if (session && (await resolvePanelSession(session.token))) return session.cookie;
  if (!(await operatorExists())) await createOperator({ name: "Test Operator", password: "test-password" });
  const { token } = await createPanelSession();
  session = { cookie: `${PANEL_SESSION_COOKIE}=${encodeURIComponent(token)}`, token };
  return session.cookie;
}

/** Forget the cached cookie, for a test file that empties the database between tests. */
export function resetOperatorSessionForTests(): void {
  session = null;
}
