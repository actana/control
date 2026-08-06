// The Panel's own version, stamped in at build time.
//
// This is what the Panel reports as *its* current version — to the update
// check, and to anything else that asks. It is deliberately only the Panel's:
// a Core in the same deployment carries its own, and the two can drift.
//
// The check that reads it (`server/services/update-check.ts`) alerts and stops
// there. With Electron gone the Panel is a container image, and updating it is
// `docker pull` — an operation the operator runs on the host, not a button the
// page can offer (ADR 0010).

declare const __MC_VERSION__: string;

export const CURRENT_MC_VERSION: string =
  typeof __MC_VERSION__ !== "undefined" ? __MC_VERSION__ : "0.0.0";
