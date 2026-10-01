CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"url" text NOT NULL,
	"secret_sealed" "bytea" NOT NULL,
	"events" text[] NOT NULL,
	"all_cores" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_cores" (
	"webhook_id" text NOT NULL,
	"core_id" text NOT NULL,
	"owner_id" integer NOT NULL,
	CONSTRAINT "webhook_cores_webhook_id_core_id_pk" PRIMARY KEY("webhook_id","core_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload" text NOT NULL,
	"core_id" text,
	"created_at" bigint NOT NULL,
	"processed_at" bigint,
	CONSTRAINT "webhook_outbox_event_type_check" CHECK ("webhook_outbox"."event_type" in ('task.created', 'task.updated', 'task.status_changed', 'task.deleted', 'comment.created', 'ping'))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"webhook_id" text NOT NULL,
	"outbox_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"claimed_until" bigint,
	"last_status_code" integer,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"delivered_at" bigint,
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" in ('pending', 'delivered', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_cores" ADD CONSTRAINT "webhook_cores_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_cores" ADD CONSTRAINT "webhook_cores_core_id_cores_id_fk" FOREIGN KEY ("core_id") REFERENCES "public"."cores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_cores" ADD CONSTRAINT "webhook_cores_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_outbox_id_webhook_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."webhook_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhooks_owner_idx" ON "webhooks" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "webhook_outbox_pending_idx" ON "webhook_outbox" USING btree ("owner_id","processed_at","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at","claimed_until");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_idx" ON "webhook_deliveries" USING btree ("created_at");
