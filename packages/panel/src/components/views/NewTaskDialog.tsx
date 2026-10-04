import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Btn } from "~/components/ui/Btn";
import { FormErrorBox } from "~/components/ui/FormErrorBox";
import { Modal } from "~/components/ui/Modal";
import { MarkdownField } from "~/components/views/MarkdownField";
import { api, ApiError } from "~/lib/api";
import { TaskAttachments } from "~/components/views/TaskAttachments";
import type { TaskAttachment } from "~/lib/task-attachments";
import { useFleet } from "~/lib/fleet-context";
import { queryKeys, useRunnableCoreAgents } from "~/queries";
import type { NewTaskRequest } from "~/shared/task-wire";

const labelStyle = { fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" } as const;

function Pick({ selected, disabled, onClick, children }: { selected: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      style={{ textAlign: "left", padding: "10px 12px", borderRadius: 8, border: `1px solid ${selected ? "var(--brand-accent)" : "var(--border)"}`, background: selected ? "var(--accent-subtle-bg)" : "transparent", color: "inherit", fontFamily: "var(--mono)", fontSize: 13, cursor: "pointer" }}
    >
      {children}
      {selected ? <span aria-hidden style={{ float: "right" }}>✓</span> : null}
    </button>
  );
}

function Form({ onClose, initialCoreId, onCreated }: { onClose: () => void; initialCoreId: string | null; onCreated?: (id: string) => void }) {
  const { cores } = useFleet();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [coreId, setCoreId] = useState<string>(initialCoreId ?? cores[0]?.id ?? "");
  const [pickedAgent, setPickedAgent] = useState<string | null>(null);
  const [startNow, setStartNow] = useState(true);
  const { data: agents = [], isLoading: agentsLoading } = useRunnableCoreAgents(coreId);
  // The Agent is one of the chosen Core's. A pick made on another Core is not it.
  const agent = agents.find((a) => a.id === pickedAgent) ?? agents.find((a) => a.isDefault) ?? agents[0] ?? null;

  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  // An attachment that could not be written leaves the Task a draft (the server never assigns it): it is not created a second time.
  const [keptDraft, setKeptDraft] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: NewTaskRequest) => api.createTask(body, ...(attachments.length > 0 ? [attachments] : [])),
    onSuccess: async ({ task }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      onClose();
      onCreated?.(task.id);
    },
    onError: async (err) => {
      const body = err instanceof ApiError ? (err.body as { taskId?: unknown } | null) : null;
      if (typeof body?.taskId === "string") {
        setKeptDraft(body.taskId);
        await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      }
    },
  });
  const submit = (assign: boolean) =>
    create.mutate({
      title: title.trim(),
      description,
      coreId: coreId || null,
      agent: agent?.id ?? null,
      startNow: assign,
    });
  const hasTitle = title.trim().length > 0;
  const canAssign = hasTitle && !!coreId && !!agent;

  return (
    <Modal
      open
      onClose={onClose}
      title="New Task"
      width={760}
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", width: "100%" }}>
          <Btn onClick={onClose}>Cancel</Btn>
          {keptDraft ? (
            <Btn
              variant="primary"
              onClick={() => {
                onClose();
                onCreated?.(keptDraft);
              }}
            >
              Open the draft
            </Btn>
          ) : null}
          <Btn variant="frame" disabled={!hasTitle || create.isPending || !!keptDraft} onClick={() => submit(false)}>
            Save as draft
          </Btn>
          <Btn variant="primary" disabled={!canAssign || create.isPending || !!keptDraft} onClick={() => submit(startNow)}>
            {startNow ? "Create & assign" : "Create"}
          </Btn>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labelStyle}>Title</span>
          <input
            aria-label="Title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "inherit", font: "inherit" }}
          />
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labelStyle}>Description</span>
          <MarkdownField value={description} onChange={setDescription} ariaLabel="Description" agentNames={agent ? [agent.name] : []} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div role="radiogroup" aria-label="Core" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={labelStyle}>Core</span>
            {cores.map((c) => (
              <Pick key={c.id} selected={coreId === c.id} onClick={() => { setCoreId(c.id); setPickedAgent(null); }}>
                {c.label} · {c.dial.state === "connected" ? "online" : "offline"}
              </Pick>
            ))}
          </div>
          <div role="radiogroup" aria-label="Agent" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={labelStyle}>Agent · harness + settings on that Core</span>
            {!coreId ? <span style={{ color: "var(--text-dim)" }}>Pick a Core first.</span> : null}
            {coreId && !agentsLoading && agents.length === 0 ? <span style={{ color: "var(--text-dim)" }}>This Core has no Agents.</span> : null}
            {agents.map((a) => (
              <Pick key={a.id} selected={agent?.id === a.id} onClick={() => setPickedAgent(a.id)}>
                {a.harness} · {a.model ?? "default"}
                {a.name !== a.harness ? ` · ${a.name}` : ""}
              </Pick>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labelStyle}>Attachments · kept in the Core's Shared folder under tasks/&lt;id&gt;/attachments</span>
          <TaskAttachments items={attachments} onChange={setAttachments} folder />
        </div>
        <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: 14, border: "1px solid var(--border)", borderRadius: 8 }}>
          <span>
            <strong>Start as soon as it is created</strong>
            <br />
            <small style={{ color: "var(--text-dim)" }}>Off = saved as Draft. On = Assigned; the Panel dispatches it to the Agent on its Core.</small>
          </span>
          <input type="checkbox" role="switch" aria-label="Start as soon as it is created" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
        </label>
        <FormErrorBox error={create.error ? (create.error instanceof Error ? create.error.message : String(create.error)) : null} />
        {keptDraft ? <div role="status" style={{ fontSize: 13, color: "var(--text-dim)" }}>The Task was saved as a draft and was not assigned. Open it from the board to try the attachment again.</div> : null}
      </div>
    </Modal>
  );
}

/** The New Task dialog (screen 06b): with attachments, a file or a whole folder, written before the Task is assigned (#568). */
export function NewTaskDialog({ open, onClose, initialCoreId, onCreated }: { open: boolean; onClose: () => void; initialCoreId: string | null; onCreated?: (id: string) => void }) {
  return open ? <Form onClose={onClose} initialCoreId={initialCoreId} onCreated={onCreated} /> : null;
}
