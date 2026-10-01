CREATE TABLE "core_shared_folders" (
	"core_id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"state" text NOT NULL,
	"s3_prefix" text NOT NULL,
	"key_expires_at" bigint,
	"last_error" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_config" (
	"owner_id" integer PRIMARY KEY NOT NULL,
	"backend" text NOT NULL,
	"endpoint" text NOT NULL,
	"bucket" text NOT NULL,
	"prefix" text NOT NULL,
	"region" text NOT NULL,
	"oidc_issuer" text NOT NULL,
	"oidc_audience" text NOT NULL,
	"key_id" text NOT NULL,
	"master_key_sealed" "bytea",
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core_shared_folders" ADD CONSTRAINT "core_shared_folders_core_id_cores_id_fk" FOREIGN KEY ("core_id") REFERENCES "public"."cores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_shared_folders" ADD CONSTRAINT "core_shared_folders_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_config" ADD CONSTRAINT "storage_config_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;