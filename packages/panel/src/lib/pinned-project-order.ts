export type PinnedOrderable = {
  id: string;
  pinned: boolean;
  pinnedOrder: number | null;
  createdAt: number;
};

function comparePinnedProjects<T extends PinnedOrderable>(left: T, right: T): number {
  const leftOrder = left.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return left.createdAt - right.createdAt;
}

export function getPinnedProjects<T extends PinnedOrderable>(
  projects: readonly T[],
): T[] {
  return projects.filter((project) => project.pinned).slice().sort(comparePinnedProjects);
}

export function nextPinnedOrder(projects: readonly PinnedOrderable[]): number {
  let max = -1;
  for (const project of projects) {
    if (!project.pinned || project.pinnedOrder == null) continue;
    if (project.pinnedOrder > max) max = project.pinnedOrder;
  }
  return max + 1;
}

export function reorderPinnedIds(currentOrder: readonly string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex === toIndex) return [...currentOrder];
  const next = [...currentOrder];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

/**
 * Splice a reordered subset (e.g. one group's pinned projects) back into the
 * full pinned order: subset members take the new relative order while keeping
 * the slots their group occupied globally; everything else stays put. Identity
 * when the subset covers the whole order. Subset ids missing from the full
 * order are ignored.
 */
export function mergeSubsetOrder(
  fullOrder: readonly string[],
  subsetOrder: readonly string[],
): string[] {
  const fullIds = new Set(fullOrder);
  const subset = subsetOrder.filter((id) => fullIds.has(id));
  const subsetIds = new Set(subset);
  let next = 0;
  return fullOrder.map((id) => (subsetIds.has(id) ? subset[next++]! : id));
}

/**
 * Check a rail order before it is written.
 *
 * The rail is one sequence of slots, and since issue 382 the ids in it can
 * belong to two owners: this Panel's own pinned rows, and the pins a Core owns
 * (which have no `projects` row here at all). So the rule is not "these ids and
 * no others" — it is:
 *
 * - every pinned project this Panel owns is named exactly once, because its
 *   slot is about to be rewritten and an absent row would keep a stale one;
 * - no id appears twice, whoever owns it;
 * - an id this Panel has no row for is a passenger. It holds a slot in the
 *   numbering so the Core-owned rows land between the right neighbours, and
 *   the write skips it.
 *
 * `panelProjectIds` — every project id in this Panel's database, pinned or not
 * — keeps the old guard against a caller sending an unpinned row of its own,
 * which the passenger rule would otherwise swallow. Omit it and unknown ids are
 * simply passengers.
 */
export function validatePinnedReorder(
  order: readonly string[],
  pinnedProjects: readonly PinnedOrderable[],
  panelProjectIds?: ReadonlySet<string>,
): void {
  const pinnedIds = new Set(pinnedProjects.map((project) => project.id));
  const seen = new Set<string>();
  for (const id of order) {
    if (seen.has(id)) throw new Error("duplicate project id in order");
    seen.add(id);
    if (!pinnedIds.has(id) && panelProjectIds?.has(id)) {
      throw new Error(`project ${id} is not pinned`);
    }
  }
  for (const id of pinnedIds) {
    if (!seen.has(id)) throw new Error("order must include every pinned project exactly once");
  }
}
