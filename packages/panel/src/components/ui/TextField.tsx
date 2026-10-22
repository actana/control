import { useId, useState, type ReactNode, type Ref } from "react";
import { Icon } from "./Icon";

export function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  ariaLabel,
  mono,
  rightAddon,
  type = "text",
  autoFocus,
  inputRef,
  autoComplete,
  spellCheck,
  required,
  ariaInvalid,
  onBlur,
  disabled,
  revealable,
}: {
  label?: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  mono?: boolean;
  rightAddon?: ReactNode;
  type?: string;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  required?: boolean;
  ariaInvalid?: boolean;
  onBlur?: () => void;
  disabled?: boolean;
  /**
   * A password field gets a show/hide eye button (44 px, for touch). Off by
   * default; the auth pages turn it on for phones only.
   */
  revealable?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const reveal = revealable === true && type === "password";
  const generatedId = useId();
  const inputId = `mc-text-field-${generatedId}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {label && (
        <label
          htmlFor={inputId}
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            fontWeight: 500,
            color: "var(--text-dim)",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </label>
      )}
      <div
        className="mc-text-field"
        style={{
          display: "flex",
          alignItems: "center",
          // Explicit height (not font-derived) so fields line up when placed
          // in a row with other 38px controls (selects, color triggers).
          height: reveal ? 44 : 38,
          background: "var(--surface-0)",
          borderRadius: 7,
          overflow: "hidden",
        }}
      >
        <input
          type={reveal && shown ? "text" : type}
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoFocus={autoFocus}
          ref={inputRef}
          aria-describedby={hintId}
          autoComplete={autoComplete}
          spellCheck={spellCheck}
          required={required}
          aria-invalid={ariaInvalid}
          onBlur={onBlur}
          disabled={disabled}
          style={{
            flex: 1,
            height: "100%",
            background: "transparent",
            border: 0,
            outline: 0,
            color: "var(--text)",
            padding: "0 12px",
            fontFamily: mono ? "var(--mono)" : "var(--sans)",
            fontSize: 13,
          }}
        />
        {reveal && (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? "Hide password" : "Show password"}
            disabled={disabled}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 44,
              height: 44,
              flexShrink: 0,
              background: "transparent",
              border: 0,
              color: "var(--text-dim)",
              cursor: "pointer",
            }}
          >
            <Icon name={shown ? "eye-off" : "eye"} size={16} />
          </button>
        )}
        {rightAddon && (
          <div
            style={{
              padding: "0 10px",
              color: "var(--text-faint)",
              fontFamily: "var(--mono)",
              fontSize: 11,
            }}
          >
            {rightAddon}
          </div>
        )}
      </div>
      {hint && (
        <div
          id={hintId}
          style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-faint)" }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
