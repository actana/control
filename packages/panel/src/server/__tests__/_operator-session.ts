import { createOperator, operatorExists } from "../services/operator";
import { createPanelSession } from "../services/panel-sessions";
import { PANEL_SESSION_COOKIE } from "../panel-auth";

let cookie: string | null = null;

/**
 * A logged-in Operator's cookie header, for tests that drive the API the way a
 * browser does. Creates the Operator on first use in whatever data directory
 * the test file pointed `AC_USER_DATA_DIR`/`AC_PANEL_DATA_DIR` at.
 */
export function operatorSessionCookie(): string {
  if (cookie) return cookie;
  if (!operatorExists()) createOperator({ name: "Test Operator", password: "test-password" });
  const { token } = createPanelSession();
  cookie = `${PANEL_SESSION_COOKIE}=${encodeURIComponent(token)}`;
  return cookie;
}
