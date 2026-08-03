import { useSyncExternalStore } from "react";

// The Panel's "currently selected Core" — the Core new mutations (Add project,
// New task, spawns from the global Add Project hotkey) route to when the user
// hasn't picked a specific Core from a per-Core view. Persists in
// `localStorage` so the choice survives reloads.
//
// `null` is a real state, not a placeholder: a fresh Panel has registered no
// Cores yet, and there is no local machine to fall back on (ADR 0010 — the
// loopback Core is gone). Callers must handle it; "add your first Core" is what
// the operator sees until one is paired.

const STORAGE_KEY = "mc:selectedCoreId";
const CHANGE_EVENT = "mc:selected-core-changed";

function readStored(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function getSelectedCoreId(): string | null {
  return readStored();
}

export function setSelectedCoreId(coreId: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (coreId) window.localStorage.setItem(STORAGE_KEY, coreId);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* quota / privacy-mode storage */
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: coreId }));
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  // Two listeners because the Panel is a web app: the CustomEvent covers this
  // tab (localStorage fires no `storage` event in the tab that wrote it), and
  // `storage` covers the operator's other open tabs.
  const onCustom = () => onChange();
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/** React binding: the current selected Core id, live across every consumer. */
export function useSelectedCoreId(): string | null {
  return useSyncExternalStore(subscribe, getSelectedCoreId, () => null);
}
