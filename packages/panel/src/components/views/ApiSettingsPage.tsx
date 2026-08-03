import { CodeBlock, Field, SettingsSection, useCopy } from "~/components/views/SettingsParts";

const REGENERATE_COMMAND = "actana token regenerate";

export function ApiSettingsPage() {
  const { copied, copy } = useCopy();

  // The hook endpoint is the Harness's, on the Core's own machine — the Panel
  // is a browser client and has no endpoint of its own to publish, and the
  // token belongs to that Harness (ADR 0010). Both are printed by `actana
  // status` on the Core.
  const baseUrl = "http://127.0.0.1:<harness-port>";

  return (
    <>
      <SettingsSection
        title="External API"
        subtitle="External CLIs (Claude Code / Codex / Cursor CLI) post status updates to the Harness on the Core they run on. Run `actana status` there for its address and token."
        headingLevel="h1"
      >
        <Field label="Endpoint">
          <CodeBlock
            value={baseUrl}
            onCopy={() => copy(baseUrl, "endpoint")}
            copied={copied === "endpoint"}
          />
        </Field>
        <Field label="API token">
          <div
            style={{ marginBottom: 8, fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}
          >
            The token lives on the Core, not in this browser. Rotate it there:
          </div>
          <CodeBlock
            value={REGENERATE_COMMAND}
            onCopy={() => copy(REGENERATE_COMMAND, "regenerate")}
            copied={copied === "regenerate"}
            monoSize={11}
          />
        </Field>
        <Field label="Example: mark a task finished">
          <CodeBlock
            value={`curl -H "Authorization: Bearer $TOKEN" \\\n  -X POST ${baseUrl}/api/tasks/$TASK_ID/status \\\n  -d '{"status":"finished","preview":"All tests passing"}'`}
            onCopy={() =>
              copy(
                `curl -H "Authorization: Bearer $TOKEN" -X POST ${baseUrl}/api/tasks/$TASK_ID/status -d '{"status":"finished","preview":"All tests passing"}'`,
                "curl",
              )
            }
            copied={copied === "curl"}
            monoSize={11}
          />
        </Field>
      </SettingsSection>
    </>
  );
}
