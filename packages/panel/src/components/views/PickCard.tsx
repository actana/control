/** A radio button card: one choice among a radiogroup (Core, Agent, Time limit). */
export function PickCard({ selected, disabled, onClick, children }: { selected: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      style={{ textAlign: "left", padding: "10px 12px", borderRadius: 8, border: `1px solid ${selected ? "var(--brand-accent)" : "var(--border)"}`, background: selected ? "var(--accent-subtle-bg)" : "transparent", color: "inherit", fontFamily: "var(--mono)", fontSize: 13, cursor: disabled ? "default" : "pointer" }}
    >
      {children}
      {selected ? <span aria-hidden style={{ float: "right" }}>✓</span> : null}
    </button>
  );
}
