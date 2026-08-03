import { createListenerSet } from "./listener-set";

export type ShipPhase = "committing" | "pushing";

type ActiveShipOperation = {
  count: number;
  phase: ShipPhase;
};

const activeShipOperations = new Map<string, ActiveShipOperation>();
const shipOperationStore = createListenerSet();
const notifyShipOperationListeners = shipOperationStore.notify;

export function shipKey(projectId: string) {
  return projectId;
}

function getShipOperation(projectId: string) {
  return activeShipOperations.get(shipKey(projectId));
}

export function isProjectShipping(projectId: string) {
  return (getShipOperation(projectId)?.count ?? 0) > 0;
}

export function getProjectShipPhase(projectId: string): ShipPhase | null {
  const op = getShipOperation(projectId);
  if (!op || op.count <= 0) return null;
  return op.phase;
}

export function beginShipOperation(projectId: string) {
  const key = shipKey(projectId);
  const prev = activeShipOperations.get(key);
  activeShipOperations.set(key, {
    count: (prev?.count ?? 0) + 1,
    phase: "committing",
  });
  notifyShipOperationListeners();
}

export function setShipPhase(projectId: string, phase: ShipPhase) {
  const key = shipKey(projectId);
  const op = activeShipOperations.get(key);
  if (!op || op.count <= 0) return;
  activeShipOperations.set(key, { ...op, phase });
  notifyShipOperationListeners();
}

export function endShipOperation(projectId: string) {
  const key = shipKey(projectId);
  const prev = activeShipOperations.get(key);
  const next = Math.max(0, (prev?.count ?? 0) - 1);
  if (next === 0) activeShipOperations.delete(key);
  else if (prev) activeShipOperations.set(key, { ...prev, count: next });
  notifyShipOperationListeners();
}

export function subscribeShipOperations(listener: () => void) {
  return shipOperationStore.subscribe(listener);
}

/** Test-only: reset global ship state between cases. */
export function resetShipOperationsForTests() {
  activeShipOperations.clear();
  notifyShipOperationListeners();
}
