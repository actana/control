import { getSetting, setSetting } from "./settings";
import { DEFAULT_BINDINGS } from "~/lib/keybindings/defaults";
import { HOTKEY_ACTIONS, type Binding, type BindingMap, type HotkeyAction } from "~/lib/keybindings/types";

const DEFAULT_SCOPE = "global";
const settingKey = (scope: string) => `keybindings:${scope}`;

function isHotkeyAction(s: string): s is HotkeyAction {
  return (HOTKEY_ACTIONS as readonly string[]).includes(s);
}

function isBinding(v: unknown): v is Binding {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.mod === "boolean" &&
    typeof b.shift === "boolean" &&
    typeof b.alt === "boolean" &&
    typeof b.key === "string" &&
    b.key.length > 0
  );
}

async function readOverrides(scope: string): Promise<Partial<BindingMap>> {
  const raw = await getSetting(settingKey(scope));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<BindingMap> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isHotkeyAction(k) && isBinding(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeOverrides(scope: string, overrides: Partial<BindingMap>): Promise<void> {
  await setSetting(settingKey(scope), JSON.stringify(overrides));
}

export async function getBindings(scope: string = DEFAULT_SCOPE): Promise<BindingMap> {
  const overrides = await readOverrides(scope);
  return { ...DEFAULT_BINDINGS, ...overrides };
}

export async function setBinding(
  action: HotkeyAction,
  binding: Binding,
  scope: string = DEFAULT_SCOPE,
): Promise<BindingMap> {
  const overrides = await readOverrides(scope);
  overrides[action] = binding;
  await writeOverrides(scope, overrides);
  return { ...DEFAULT_BINDINGS, ...overrides };
}

export async function resetBinding(
  action: HotkeyAction,
  scope: string = DEFAULT_SCOPE,
): Promise<BindingMap> {
  const overrides = await readOverrides(scope);
  delete overrides[action];
  await writeOverrides(scope, overrides);
  return { ...DEFAULT_BINDINGS, ...overrides };
}

export async function resetAllBindings(scope: string = DEFAULT_SCOPE): Promise<BindingMap> {
  await writeOverrides(scope, {});
  return { ...DEFAULT_BINDINGS };
}
