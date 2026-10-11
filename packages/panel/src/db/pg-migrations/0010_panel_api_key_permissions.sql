-- #688: per-key permissions. Every key that exists at this point could do everything a key can do,
-- so it is given the full set (the default below), and the default is then dropped: from here on a
-- key is only ever inserted with the permissions it was created with.
ALTER TABLE "api_keys" ADD COLUMN "permissions" text[] DEFAULT array['read', 'tasks:write', 'agents:write']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "permissions" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_permissions_check" CHECK (cardinality("api_keys"."permissions") > 0 and "api_keys"."permissions" <@ array['read', 'tasks:write', 'agents:write']::text[]);
