import { bootPanelDatabase } from "~/db/pg-boot";
import { coreLinkManager } from "./services/core-link-manager";
import { startWebhookDeliveryWorker } from "./services/webhook-delivery-worker";

/**
 * Bring the Panel's database up, then the core links that read it.
 *
 * The Core registry lives in Postgres, so the links cannot be dialed at import
 * time as they were on SQLite: the pool is opened, checked and migrated first
 * (`bootPanelDatabase`, which throws when the Panel must not start), and only
 * then are the registered Cores dialed. `bin/panel.mjs` and the Vite dev server
 * both enter here.
 */
export async function bootPanel(
  ...args: Parameters<typeof bootPanelDatabase>
): ReturnType<typeof bootPanelDatabase> {
  const pool = await bootPanelDatabase(...args);
  // Not awaited: a Core that is slow to read must not hold up listening. A
  // failure is logged, and a Core that did not dial is dialed by the next pairing.
  void coreLinkManager()
    .start()
    .catch((err: unknown) => {
      console.error(
        `[panel] could not dial the registered Cores: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  startWebhookDeliveryWorker();
  return pool;
}
