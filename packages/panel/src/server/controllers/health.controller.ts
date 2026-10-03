import { sql } from "drizzle-orm";
import { panelDb } from "~/db/panel-db-handle";
import { json } from "../http-responses";

type DatabaseCheck = "ok" | "error";

type HealthResponse = {
  ok: boolean;
  status: "ok" | "error";
  uptimeSeconds: number;
  checks: {
    api: "ok";
    database: DatabaseCheck;
  };
};

/**
 * Upper bound on the Postgres probe. Stays under the image HEALTHCHECK's 5 s
 * so a hung pooled connection still yields a 503 instead of no answer.
 */
export const DATABASE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Probe the Panel's Postgres with `select 1`, raced against
 * {@link DATABASE_PROBE_TIMEOUT_MS}. The answer is only `"ok"` or `"error"` —
 * never a driver message — so a failed or hung probe cannot leak the
 * connection URL (which carries the password) into an unauthenticated response.
 */
async function checkDatabase(): Promise<DatabaseCheck> {
  try {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), DATABASE_PROBE_TIMEOUT_MS);
      timer.unref();
    });
    await Promise.race([panelDb().execute(sql`select 1`), timeout]);
    return "ok";
  } catch {
    return "error";
  }
}

/** Readiness (API + Postgres) for load balancers and the image HEALTHCHECK. Unauthenticated. */
export async function read(): Promise<Response> {
  const database = await checkDatabase();
  const ok = database === "ok";
  const body: HealthResponse = {
    ok,
    status: ok ? "ok" : "error",
    uptimeSeconds: Math.floor(process.uptime()),
    checks: {
      api: "ok",
      database,
    },
  };

  return json(body, { status: ok ? 200 : 503 });
}
