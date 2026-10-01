CREATE TABLE "core_secrets" (
	"core_id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"sealed" "bytea" NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cores" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"endpoint" text NOT NULL,
	"label" text NOT NULL,
	"last_event_id" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "cores_owner_endpoint_unique" UNIQUE("owner_id","endpoint")
);
--> statement-breakpoint
CREATE TABLE "operator" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"password_changed_at" bigint NOT NULL,
	CONSTRAINT "operator_single_row" CHECK ("operator"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "panel_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "panel_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "core_secrets" ADD CONSTRAINT "core_secrets_core_id_cores_id_fk" FOREIGN KEY ("core_id") REFERENCES "public"."cores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_secrets" ADD CONSTRAINT "core_secrets_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cores" ADD CONSTRAINT "cores_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_sessions" ADD CONSTRAINT "panel_sessions_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "panel_sessions_expires_at_idx" ON "panel_sessions" USING btree ("expires_at");