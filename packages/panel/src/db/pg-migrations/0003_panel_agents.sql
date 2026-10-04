CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"core_id" text NOT NULL,
	"name" text NOT NULL,
	"harness" text NOT NULL,
	"model" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "agents_core_name_unique" UNIQUE("core_id","name"),
	CONSTRAINT "agents_harness_check" CHECK ("agents"."harness" in ('claude-code', 'codex', 'cursor-cli', 'opencode', 'pi'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_core_id_cores_id_fk" FOREIGN KEY ("core_id") REFERENCES "public"."cores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_default_per_harness" ON "agents" USING btree ("core_id","harness") WHERE "agents"."is_default";--> statement-breakpoint
CREATE INDEX "agents_owner_core_idx" ON "agents" USING btree ("owner_id","core_id");