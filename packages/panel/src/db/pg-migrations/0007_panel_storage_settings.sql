ALTER TABLE "storage_config" ADD COLUMN "role_arn" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_config" ADD COLUMN "account_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_config" ADD COLUMN "parent_access_key_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_config" ADD COLUMN "anon_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_config" ADD COLUMN "master_key_rotated_at" bigint;--> statement-breakpoint
ALTER TABLE "storage_config" ADD COLUMN "upload_size_limit_bytes" bigint DEFAULT 536870912 NOT NULL;
