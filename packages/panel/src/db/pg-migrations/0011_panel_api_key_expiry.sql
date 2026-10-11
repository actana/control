-- #689: optional expiry. A key with a NULL expires_at lives until it is revoked, which is what every
-- key created before this column did, so the keys that exist at this point are left NULL.
-- Runs after #688's 0010_panel_api_key_permissions, which lands in the same release.
ALTER TABLE "api_keys" ADD COLUMN "expires_at" bigint;
