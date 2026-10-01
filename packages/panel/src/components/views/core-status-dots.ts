import type { SessionStatus } from "@actana/shared/domain";

export const CORE_STATUS_DOT_LIMIT = 4;

export type CoreStatusDot = Extract<SessionStatus, "running" | "finished">;

const STATUS_DOT_PRECEDENCE = [
  "running",
  "finished",
] as const satisfies readonly CoreStatusDot[];

export function getCoreStatusDots(
  counts: Pick<Record<SessionStatus, number>, CoreStatusDot>
): CoreStatusDot[] {
  const dots: CoreStatusDot[] = [];

  for (const status of STATUS_DOT_PRECEDENCE) {
    const openSlots = CORE_STATUS_DOT_LIMIT - dots.length;
    if (openSlots <= 0) break;

    const count = Math.max(0, Math.trunc(counts[status] ?? 0));
    const dotCount = Math.min(count, openSlots);
    for (let i = 0; i < dotCount; i += 1) dots.push(status);
  }

  return dots;
}
