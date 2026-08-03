// The Panel's own version, stamped in at build time.
//
// There is no release check here: with Electron gone the Panel is a container
// image, and updating it is `docker pull` — an operation the operator runs on
// the host, not a button the page can offer (ADR 0010).

declare const __MC_VERSION__: string;

export const CURRENT_MC_VERSION: string =
  typeof __MC_VERSION__ !== "undefined" ? __MC_VERSION__ : "0.0.0";
