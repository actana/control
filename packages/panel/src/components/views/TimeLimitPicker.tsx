import { useEffect, useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { PickCard } from "~/components/views/PickCard";
import {
  TASK_TIMEOUT_MAX_MINUTES,
  TASK_TIMEOUT_MIN_MINUTES,
  TASK_TIME_LIMIT_PRESETS,
  formatTaskTimeLimit,
  isValidTaskTimeoutMinutes,
  type TaskTimeoutMinutes,
} from "~/shared/tasks";

const isPreset = (v: number | null) => v !== null && (TASK_TIME_LIMIT_PRESETS as readonly number[]).includes(v);

/**
 * The Time limit pick cards (#724): the presets, "Custom…" with a minutes field, and "No limit".
 * `onChange` only gets valid values. `onValidChange` says whether a Custom entry is usable,
 * so the parent can keep its submit off while it is not.
 */
export function TimeLimitPicker({
  value,
  onChange,
  onValidChange,
  disabled,
  commitCustom = "change",
  idPrefix = "time-limit",
}: {
  value: TaskTimeoutMinutes;
  onChange: (minutes: TaskTimeoutMinutes) => void;
  onValidChange?: (valid: boolean) => void;
  /** Cards and the Set button; never the Minutes field, so a pending save does not take its focus. */
  disabled?: boolean;
  /** "change": every valid Custom entry calls onChange. "explicit": only Set or Enter. */
  commitCustom?: "change" | "explicit";
  idPrefix?: string;
}) {
  const [custom, setCustom] = useState(value !== null && !isPreset(value));
  const [text, setText] = useState(value !== null && !isPreset(value) ? String(value) : "");
  const parsed = text.trim() === "" ? NaN : Number(text);
  const customValid = isValidTaskTimeoutMinutes(parsed) && parsed !== null;
  const valid = !custom || customValid;

  useEffect(() => {
    onValidChange?.(valid);
  }, [valid, onValidChange]);

  const commit = () => {
    if (customValid && parsed !== value) onChange(parsed);
  };

  const pick = (minutes: TaskTimeoutMinutes) => {
    setCustom(false);
    onChange(minutes);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div role="radiogroup" aria-label="Time limit" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {TASK_TIME_LIMIT_PRESETS.map((m) => (
          <PickCard key={m} selected={!custom && value === m} disabled={disabled} onClick={() => pick(m)}>
            {formatTaskTimeLimit(m)}
          </PickCard>
        ))}
        <PickCard
          selected={custom}
          disabled={disabled}
          onClick={() => {
            setCustom(true);
            setText(value !== null ? String(value) : "");
          }}
        >
          Custom…
        </PickCard>
        <PickCard selected={!custom && value === null} disabled={disabled} onClick={() => pick(null)}>
          No limit
        </PickCard>
      </div>
      {custom ? (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input
            id={`${idPrefix}-minutes`}
            type="number"
            aria-label="Minutes"
            aria-invalid={!customValid}
            min={TASK_TIMEOUT_MIN_MINUTES}
            max={TASK_TIMEOUT_MAX_MINUTES}
            step={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (commitCustom === "explicit") return;
              const n = e.target.value.trim() === "" ? NaN : Number(e.target.value);
              if (isValidTaskTimeoutMinutes(n) && n !== null) onChange(n);
            }}
            onKeyDown={(e) => {
              if (commitCustom === "explicit" && e.key === "Enter") {
                e.preventDefault();
                if (!disabled) commit();
              }
            }}
            style={{ width: 120, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "inherit", font: "inherit" }}
          />
          {commitCustom === "explicit" ? (
            <Btn variant="primary" disabled={disabled || !customValid} onClick={commit}>
              Set
            </Btn>
          ) : null}
          <span style={{ color: "var(--text-dim)" }}>minutes ({TASK_TIMEOUT_MIN_MINUTES} to {TASK_TIMEOUT_MAX_MINUTES})</span>
        </label>
      ) : null}
      {!valid ? (
        <div role="alert" style={{ fontSize: 13, color: "var(--danger, #e5484d)" }}>
          Give a whole number of minutes from {TASK_TIMEOUT_MIN_MINUTES} to {TASK_TIMEOUT_MAX_MINUTES}.
        </div>
      ) : null}
      <small style={{ color: "var(--text-dim)" }}>
        {value === null && !custom
          ? "The attempt runs until the agent reports or its Session ends; the Panel still checks once a minute that the Session is alive."
          : `If the agent has written no result after ${formatTaskTimeLimit(value)}, the Panel fails the attempt and stops its Session.`}
      </small>
    </div>
  );
}
