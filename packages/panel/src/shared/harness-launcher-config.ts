import { HARNESSES, type Harness } from "@actana/shared/domain";

/**
 * User preference for the New Session agent picker: display order plus a set
 * of hidden agents. Hiding only removes an agent from the picker — a project's
 * saved agent still launches through the skip-dialog path.
 */
export type HarnessLauncherConfig = {
  order: Harness[];
  hidden: Harness[];
};

export const DEFAULT_AGENT_LAUNCHER_CONFIG: HarnessLauncherConfig = {
  order: [...HARNESSES],
  hidden: [],
};

const HARNESS_SET = new Set<string>(HARNESSES);

function toHarnessList(value: unknown): Harness[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<Harness>();
  for (const entry of value) {
    if (typeof entry === "string" && HARNESS_SET.has(entry)) {
      seen.add(entry as Harness);
    }
  }
  return [...seen];
}

/**
 * Coerce any stored/posted value into a valid config: unknown ids and
 * duplicates are dropped, agents missing from `order` are appended in default
 * order, and at least one agent is always left visible.
 */
export function normalizeHarnessLauncherConfig(raw: unknown): HarnessLauncherConfig {
  if (typeof raw !== "object" || raw === null) {
    return {
      order: [...DEFAULT_AGENT_LAUNCHER_CONFIG.order],
      hidden: [],
    };
  }
  const input = raw as { order?: unknown; hidden?: unknown };
  const order = toHarnessList(input.order);
  for (const agent of HARNESSES) {
    if (!order.includes(agent)) order.push(agent);
  }
  const orderSet = new Set(order);
  let hidden = toHarnessList(input.hidden).filter((agent) => orderSet.has(agent));
  if (hidden.length >= order.length) {
    hidden = hidden.filter((agent) => agent !== order[0]);
  }
  return { order, hidden };
}

/** Harnesses to show in the picker, in configured order. Never empty. */
export function visibleLauncherHarnesses(config: HarnessLauncherConfig): Harness[] {
  const hidden = new Set(config.hidden);
  return config.order.filter((agent) => !hidden.has(agent));
}
