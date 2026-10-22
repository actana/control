import { Icon } from "~/components/ui/Icon";
import { CORE_TABS, type CoreTab } from "~/components/views/CoreHeader";

// The Core's sections as a bottom tab bar on compact screens (M20). The same
// three tabs as the header's tablist, which compact CSS hides.

export function CoreTabBar({ tab, onTab }: { tab: CoreTab; onTab: (tab: CoreTab) => void }) {
  return (
    <nav aria-label="Core sections" className="mc-core-tabbar">
      {CORE_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-current={tab === t.id ? "page" : undefined}
          onClick={() => onTab(t.id)}
          style={{ minHeight: 44, minWidth: 44 }}
        >
          <Icon name={t.icon} size={18} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
