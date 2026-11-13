/**
 * Remembers what each Session or Task was last seen as, so a notification is raised when it *enters* a
 * blocked state and not on every poll that still finds it there (#954). One tracker per kind of thing.
 *
 * The first `update` that carries a group only learns that group's baseline: a Panel opened on a Session that already waits is
 * not news. An entry that is `suppressed` (the Operator is looking at it) is still recorded, so it does not
 * fire the moment they look away. A key missing from a later snapshot keeps its last state: a page boundary
 * must not make it look new again.
 */
export type BlockedEntry = { key: string; state: string | null; suppressed?: boolean; /** What loads together (a Core); each group learns its own baseline. */ group?: string };

const CAP = 2000;

export function createBlockedTracker(triggers: ReadonlySet<string>) {
  const last = new Map<string, string | null>();
  // Groups whose baseline is known: a Core that answers later than the others is not news either.
  const primed = new Set<string>();
  return {
    /** The keys that entered a trigger state since the last call and should be announced. */
    update(entries: readonly BlockedEntry[]): string[] {
      const fire: string[] = [];
      const seen = new Set<string>();
      for (const { key, state, suppressed, group = "" } of entries) {
        seen.add(group);
        const before = last.get(key);
        if (primed.has(group) && state !== null && triggers.has(state) && before !== state && !suppressed) fire.push(key);
        last.delete(key);
        last.set(key, state);
      }
      while (last.size > CAP) {
        const oldest = last.keys().next().value;
        if (oldest === undefined) break;
        last.delete(oldest);
      }
      for (const g of seen) primed.add(g);
      return fire;
    },
  };
}
