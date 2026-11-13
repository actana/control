-- #949: what the Session of a Task's running attempt is doing (working, needs-input, interrupted, idle-no-result, exited); NULL when no attempt runs.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "session_state" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "session_state_at" bigint;--> statement-breakpoint
-- #949: the outbox may carry task.session_state_changed.
ALTER TABLE "webhook_outbox" DROP CONSTRAINT IF EXISTS "webhook_outbox_event_type_check";--> statement-breakpoint
ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_event_type_check" CHECK ("webhook_outbox"."event_type" in ('task.created', 'task.updated', 'task.status_changed', 'task.session_state_changed', 'task.deleted', 'comment.created', 'ping'));
