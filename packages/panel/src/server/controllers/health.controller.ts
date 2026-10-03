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
 * Probe the Panel's Postgres with `select 1`. The answer is only `"ok"` or
 * `"error"` — never a driver message — so a failed probe cannot leak the
 * connection URL (which carries the password) into an unauthenticated response.
 */
async function checkDatabase(): Promise<DatabaseCheck> {
  try {
    await panelDb().execute(sql`select 1`);
    return "ok";
  } catch {
    return "error";
  }
}

/** Liveness for load balancers and the image HEALTHCHECK. Unauthenticated. */
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
