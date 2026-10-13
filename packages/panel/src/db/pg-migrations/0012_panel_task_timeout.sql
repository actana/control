-- #724: a time limit per Task, in minutes; NULL = No limit. Existing Tasks get 60, as before.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "timeout_minutes" integer DEFAULT 60;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_timeout_minutes_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_timeout_minutes_check" CHECK ("tasks"."timeout_minutes" is null or ("tasks"."timeout_minutes" >= 1 and "tasks"."timeout_minutes" <= 43200));
