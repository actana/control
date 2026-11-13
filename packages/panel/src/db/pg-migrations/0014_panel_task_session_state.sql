-- #949: what the Session of a Task's running attempt is doing (working, needs-input, interrupted, idle-no-result, exited); NULL when no attempt runs.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "session_state" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "session_state_at" bigint;
