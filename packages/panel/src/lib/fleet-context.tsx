import { createContext, useContext, type ReactNode } from "react";
import { useFleetSessions } from "~/lib/use-fleet";

type Fleet = ReturnType<typeof useFleetSessions>;

const FleetContext = createContext<Fleet | null>(null);

/**
 * One fleet fan-out for the whole shell. The rail, the Fleet home and a Core's
 * page all draw from the same `sessionRowsList` answers; mounting the hook in
 * each would cost a fan-out per surface on every session event.
 */
export function FleetProvider({ children }: { children: ReactNode }) {
  const fleet = useFleetSessions();
  return <FleetContext.Provider value={fleet}>{children}</FleetContext.Provider>;
}

export function useFleet(): Fleet {
  const fleet = useContext(FleetContext);
  if (!fleet) throw new Error("useFleet must be used inside <FleetProvider>");
  return fleet;
}
