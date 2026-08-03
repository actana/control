import { json } from "../http-responses";

type HealthResponse = {
  ok: boolean;
  status: "ok";
  uptimeSeconds: number;
  checks: {
    api: "ok";
    database: "disabled";
  };
};

export function read(): Response {
  const body: HealthResponse = {
    ok: true,
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
    checks: {
      api: "ok",
      database: "disabled",
    },
  };

  return json(body);
}
