import { eq } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { appSettings } from "~/db/pg-schema";

/** Every query here filters on `owner_id` (ADR 0041 D15). */

export async function getAppSetting(ownerId: number, key: string): Promise<string | null> {
  const rows = await panelDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(ownedBy(appSettings, ownerId, eq(appSettings.key, key)))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function setAppSetting(ownerId: number, key: string, value: string): Promise<void> {
  await panelDb()
    .insert(appSettings)
    .values({ ownerId, key, value })
    .onConflictDoUpdate({
      target: [appSettings.ownerId, appSettings.key],
      set: { value },
    });
}

export async function deleteAppSetting(ownerId: number, key: string): Promise<void> {
  await panelDb()
    .delete(appSettings)
    .where(ownedBy(appSettings, ownerId, eq(appSettings.key, key)));
}
