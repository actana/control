/** `order` with the id at `fromIndex` moved to `toIndex`; a new array either way. */
export function reorderIds(order: readonly string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex === toIndex) return [...order];
  const next = [...order];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}
