import { bootPanelDatabase } from "~/db/pg-boot";
import { closePanelDatabase } from "~/db/pg";
import { coreLinkManager } from "./services/core-link-manager";
import { sharedFolders } from "./services/shared-folders";
import { startWebhookDeliveryWorker } from "./services/webhook-delivery-worker";
import { startTaskDispatch, stopTaskDispatch } from "./task-dispatch";

/**
 * Bring the Panel's database up, then the core links that read it.
 *
 * The Core registry lives in Postgres, so the links cannot be dialed at import
 * time as they were on SQLite: the pool is opened, checked and migrated first
 * (`bootPanelDatabase`, which throws when the Panel must not start), and only
 * then are the registered Cores dialed. `bin/panel.mjs` and the Vite dev server
 * both enter here.
 *
 * Then the Task dispatcher starts (#570): it claims `assigned` Tasks and watches
 * their result files for as long as the Panel is up, and `closePanel` stops it.
 * The webhook delivery worker (#574) runs alongside it.
 */
let stopSharedFolders: (() => void) | null = null;

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
  // Keeps every attached Core's 1-hour Shared-folder key fresh (#564); stopped by `closePanel`.
  void sharedFolders()
    .start()
    .then((stop) => {
      stopSharedFolders = stop;
    })
    .catch((err: unknown) => {
      console.error(
        `[panel] could not start the Shared folder key refresh: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  startTaskDispatch();
  startWebhookDeliveryWorker();
  return pool;
}

/** Shutdown: stop dispatching and watching first, then close the database they read. */
export async function closePanel(): Promise<void> {
  stopSharedFolders?.();
  stopSharedFolders = null;
  await stopTaskDispatch();
  await closePanelDatabase();
}
