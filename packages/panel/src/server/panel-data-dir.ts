import * as os from "node:os";
import * as path from "node:path";

/**
 * Per-platform default for the directory the Panel keeps its state in when the
 * operator names none. Also the legacy app database's home (see db/client.ts),
 * which is why it lives here rather than inside either database module.
 */
export function defaultAppDataDir(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library/Application Support/Actana Control");
  }
  if (process.platform === "win32") return path.join(home, "AppData/Roaming/Actana Control");
  return path.join(home, ".config/Actana Control");
}

/**
 * The one directory every piece of Panel state lives in — Operator, sessions,
 * settings today; the Core registry and its encrypted secrets as those land.
 * `AC_PANEL_DATA_DIR` is the deployment knob (a mounted volume under Docker);
 * `AC_USER_DATA_DIR` is honored so a Panel booted by its host during
 * the extraction shares that shell's directory.
 */
export function resolvePanelDataDir(): string {
  const explicit = process.env.AC_PANEL_DATA_DIR?.trim();
  if (explicit) return explicit;
  const legacy = process.env.AC_USER_DATA_DIR?.trim();
  if (legacy) return legacy;
  return defaultAppDataDir();
}
