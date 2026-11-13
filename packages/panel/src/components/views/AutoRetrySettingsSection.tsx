import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Btn } from "~/components/ui/Btn";
import { Field, SettingsSection, ToggleRow, ValueRow } from "~/components/views/SettingsParts";
import { api, type AutoRetrySettingsView } from "~/lib/api";
import { queryKeys, useAutoRetrySettings } from "~/queries";

const CEILINGS = [1, 2, 3] as const;

/**
 * Settings › General › Auto-retry (#958): the instance kill switch, the attempts ceiling a Task's request is clamped to,
 * and the Cores whose circuit breaker paused auto-retry until the Operator resumes them.
 */
export function AutoRetrySettingsSection() {
  const queryClient = useQueryClient();
  const { data } = useAutoRetrySettings();
  const [error, setError] = useState<string | null>(null);

  const run = async (call: () => Promise<AutoRetrySettingsView>) => {
    setError(null);
    try {
      queryClient.setQueryData(queryKeys.autoRetrySettings, await call());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the auto-retry settings.");
    }
  };

  return (
    <SettingsSection
      title="Auto-retry"
      subtitle="Tasks that opt in are assigned again when their Session dies without a result."
    >
      <Field label="Auto-retry">
        <ToggleRow
          title="Auto-retry"
          description="The kill switch: off stops every retry, also for Tasks that already asked for it and for retries that are waiting."
          checked={data?.enabled ?? true}
          disabled={!data}
          onChange={(enabled) => void run(() => api.updateAutoRetrySettings({ enabled }))}
          label="Enable auto-retry"
        />
      </Field>
      <Field label="Maximum attempts">
        <ValueRow
          values={CEILINGS}
          value={(data?.maxAttemptsCeiling ?? 3) as (typeof CEILINGS)[number]}
          ariaLabel="Maximum attempts"
          onSelect={(maxAttemptsCeiling) => void run(() => api.updateAutoRetrySettings({ maxAttemptsCeiling }))}
        />
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>
          A Task asking for more attempts gets this many.
        </div>
      </Field>
      <Field label="Paused Cores">
        {data && data.pausedCores.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.pausedCores.map((core) => (
              <div
                key={core.coreId}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 14px", background: "var(--surface-0)", border: "1px solid var(--border)", borderRadius: 7 }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{core.label}</div>
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Three auto-retries within an hour paused auto-retry on this Core.</div>
                </div>
                <Btn type="button" variant="solid" size="sm" onClick={() => void run(() => api.resumeAutoRetryCore(core.coreId))}>
                  Resume
                </Btn>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No Core is paused.</div>
        )}
      </Field>
      {error ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger, #e5484d)" }}>
          {error}
        </div>
      ) : null}
    </SettingsSection>
  );
}
