import { readPanelUpdateCheck } from "../services/update-check";
import { json } from "./_helpers";

/**
 * GET /api/update-check — whether a newer Actana release exists.
 *
 * Read-only by construction: there is no companion POST, because there is
 * nothing for the browser to trigger. The banner this feeds names the command
 * the operator runs on the host; it never offers to run it (ADR 0010).
 */
export async function read(): Promise<Response> {
  return json(await readPanelUpdateCheck());
}
