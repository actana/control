-- #958: opt-in auto-retry of a Task whose Session died without a result: {maxAttempts, retries, inherited, notBefore, lastCause, notice}; NULL = not opted in.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_retry" jsonb;
