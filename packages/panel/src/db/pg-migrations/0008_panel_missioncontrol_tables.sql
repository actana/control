CREATE TABLE "app_settings" (
	"owner_id" integer NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "app_settings_owner_id_key_pk" PRIMARY KEY("owner_id","key")
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"event_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_log_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" integer NOT NULL,
	"ts" bigint NOT NULL,
	"kind" text NOT NULL,
	"pty_id" text,
	"session_id" text,
	"payload" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_terminals" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"name" text NOT NULL,
	"cwd" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"title" text NOT NULL,
	"title_manually_set" boolean DEFAULT false NOT NULL,
	"icon" text,
	"agent" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"preview" text DEFAULT '' NOT NULL,
	"lines" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"claude_session_id" text,
	"claude_skip_permissions" boolean DEFAULT false NOT NULL,
	"claude_bare_session" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminal_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"session_id" text NOT NULL,
	"chunk" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"session_id" text NOT NULL,
	"claude_session_id" text NOT NULL,
	"message_uuid" text NOT NULL,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"ts" bigint NOT NULL,
	CONSTRAINT "token_usage_message_uuid_unique" UNIQUE("message_uuid")
);
--> statement-breakpoint
CREATE TABLE "token_usage_rollup" (
	"owner_id" integer NOT NULL,
	"session_id" text NOT NULL,
	"day" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"last_ts" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "token_usage_rollup_session_id_day_pk" PRIMARY KEY("session_id","day")
);
--> statement-breakpoint
CREATE TABLE "token_usage_session_offsets" (
	"owner_id" integer NOT NULL,
	"claude_session_id" text NOT NULL,
	"session_id" text NOT NULL,
	"byte_offset" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "token_usage_session_offsets_owner_claude_pk" PRIMARY KEY("owner_id","claude_session_id")
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_terminals" ADD CONSTRAINT "home_terminals_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_logs" ADD CONSTRAINT "terminal_logs_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_logs" ADD CONSTRAINT "terminal_logs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_rollup" ADD CONSTRAINT "token_usage_rollup_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_rollup" ADD CONSTRAINT "token_usage_rollup_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_session_offsets" ADD CONSTRAINT "token_usage_session_offsets_owner_id_operator_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_session_offsets" ADD CONSTRAINT "token_usage_session_offsets_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_log_kind_idx" ON "event_log" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "event_log_session_idx" ON "event_log" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "event_log_pty_idx" ON "event_log" USING btree ("pty_id");--> statement-breakpoint
CREATE INDEX "event_log_owner_idx" ON "event_log" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "home_terminals_owner_idx" ON "home_terminals" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_archived_idx" ON "sessions" USING btree ("archived");--> statement-breakpoint
CREATE INDEX "sessions_pinned_idx" ON "sessions" USING btree ("pinned");--> statement-breakpoint
CREATE INDEX "sessions_owner_idx" ON "sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "terminal_logs_session_idx" ON "terminal_logs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "token_usage_session_idx" ON "token_usage" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "token_usage_ts_idx" ON "token_usage" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "token_usage_ts_cover_idx" ON "token_usage" USING btree ("ts","input_tokens","output_tokens","cache_creation_tokens","cache_read_tokens");--> statement-breakpoint
CREATE INDEX "token_usage_session_ts_cover_idx" ON "token_usage" USING btree ("session_id","ts","input_tokens","output_tokens","cache_creation_tokens","cache_read_tokens");--> statement-breakpoint
CREATE INDEX "token_usage_rollup_session_idx" ON "token_usage_rollup" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "token_usage_rollup_day_idx" ON "token_usage_rollup" USING btree ("day");