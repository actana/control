-- #896: the Tasks board pages one status column at a time, newest update first (keyset on updated_at, id).
CREATE INDEX IF NOT EXISTS "tasks_owner_status_updated_idx" ON "tasks" USING btree ("owner_id","status","updated_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
