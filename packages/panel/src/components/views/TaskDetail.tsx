import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Btn } from "~/components/ui/Btn";
import { FormErrorBox } from "~/components/ui/FormErrorBox";
import { Icon } from "~/components/ui/Icon";
import { MarkdownField } from "~/components/views/MarkdownField";
import { TaskMarkdown } from "~/components/views/TaskMarkdown";
import { api } from "~/lib/api";
import { useFleet } from "~/lib/fleet-context";
import { formatRelativeTime } from "~/lib/format-relative-time";
import { TASK_STATUS_LABEL } from "~/lib/task-board";
import { queryKeys, useCoreAgents, useTask } from "~/queries";
import { FINISHED_TASK_STATUSES } from "~/shared/tasks";
import { taskFolderPath } from "~/shared/shared-files";
import type { TaskCommentDto } from "~/shared/task-wire";
import { TaskAttachments } from "~/components/views/TaskAttachments";
import type { TaskAttachment } from "~/lib/task-attachments";

const KIND_COLOR: Record<TaskCommentDto["authorKind"], string> = {
  system: "var(--border)",
  agent: "var(--warning)",
  user: "var(--brand-accent)",
};

function Badge({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.05em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 4, background: tone ?? "var(--surface-4)" }}>
      {children}
    </span>
  );
}

function message(e: unknown): string | null {
  return e ? (e instanceof Error ? e.message : String(e)) : null;
}

/**
 * A Task's detail (screen 07): badges, result files, the comment thread and a
 * large composer. Every status move is a call to the server; this view only
 * shows what comes back. Open folder jumps to the Task's folder in the Core's Files tab (#565); Attach file waits for a later PR.
 */
export function TaskDetail({ taskId, onClose, focusComposer = false }: { taskId: string; onClose: () => void; focusComposer?: boolean }) {
  const { cores } = useFleet();
  // Outside a router (a bare render) there is nothing to navigate: the button then stays off.
  const router = useRouter({ warn: false });
  const queryClient = useQueryClient();
  const { data, error } = useTask(taskId);
  const task = data?.task;
  const comments = data?.comments ?? [];
  const { data: agents = [] } = useCoreAgents(task?.coreId ?? "");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
  const comment = useMutation({
    mutationFn: (reassign: boolean) => api.commentOnTask(taskId, { body: draft, reassign }, ...(attachments.length > 0 ? [attachments] : [])),
    onSuccess: async () => {
      setDraft("");
      setAttachments([]);
      await refresh();
    },
  });
  const move = useMutation({
    mutationFn: (status: "assigned" | "draft") => api.setTaskStatus(taskId, status),
    onSuccess: refresh,
  });

  const finished = !!task && (FINISHED_TASK_STATUSES as readonly string[]).includes(task.status);
  const core = cores.find((c) => c.id === task?.coreId);
  const agent = agents.find((a) => a.id === task?.agent);
  const resultFiles = [...new Set(comments.filter((c) => c.authorKind === "agent" && c.sourceFile).map((c) => c.sourceFile as string))];
  // A file is a comment on its own: the server names it in the comment.
  const hasBody = draft.trim().length > 0 || attachments.length > 0;

  return (
    <aside
      role="dialog"
      aria-label="Task detail"
      style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(720px, 100vw)", zIndex: 9000, overflowY: "auto", padding: 24, background: "var(--surface-card)", borderLeft: "1px solid var(--border)", boxShadow: "-8px 0 32px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", gap: 16 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)" }}>
        <span>TASK · {taskId}{task ? ` · created ${formatRelativeTime(task.createdAt)}` : ""}</span>
        <button type="button" aria-label="Close" onClick={onClose} className="mc-btn mc-btn-ghost mc-btn-sm">
          <Icon name="x" />
        </button>
      </div>
      {error && !task ? <FormErrorBox error={message(error)} /> : null}
      {task ? (
        <>
          <h2 style={{ margin: 0, fontSize: 26 }}>{task.title}</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Badge tone="var(--accent-subtle-bg)">{TASK_STATUS_LABEL[task.status]}</Badge>
            {task.attemptCount > 0 ? <Badge>Attempt {task.attemptCount}</Badge> : null}
            {core ? <Badge>{core.label}</Badge> : null}
            {agent ? <Badge>Agent: {agent.name}</Badge> : null}
          </div>
          {task.description ? <TaskMarkdown>{task.description}</TaskMarkdown> : null}
          {task.lastError ? <FormErrorBox error={task.lastError} /> : null}
          {task.status === "draft" || task.status === "assigned" ? (
            <div style={{ display: "flex", gap: 8 }}>
              {task.status === "draft" ? (
                <Btn variant="primary" disabled={!task.coreId || !task.agent || move.isPending} onClick={() => move.mutate("assigned")}>
                  Assign
                </Btn>
              ) : (
                <Btn variant="frame" disabled={move.isPending} onClick={() => move.mutate("draft")}>
                  Back to draft
                </Btn>
              )}
            </div>
          ) : null}
          <section aria-label="Result files">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>Result files</h3>
              <Btn
                variant="ghost"
                icon="folder"
                disabled={!router || !task.coreId}
                title={task.coreId ? "Open this Task's folder in the Core's Files tab" : "Assign the Task to a Core first"}
                onClick={() => {
                  if (!router || !task.coreId) return;
                  void router.navigate({ to: "/cores/$coreId", params: { coreId: task.coreId }, search: { tab: "files", path: taskFolderPath(task.id) } });
                  onClose();
                }}
              >
                Open folder
              </Btn>
            </div>
            {resultFiles.length === 0 ? (
              <div style={{ color: "var(--text-dim)", fontSize: 13 }}>None yet.</div>
            ) : (
              resultFiles.map((f) => (
                <div key={f} style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", fontFamily: "var(--mono)", fontSize: 13 }}>
                  <span><Icon name="folder" /> {f}</span>
                  <span style={{ color: "var(--text-dim)" }}>→ comment below</span>
                </div>
              ))
            )}
          </section>
          <section aria-label="Comments" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h3 style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>Comments</h3>
            {comments.map((c) => (
              <article key={c.id} data-comment-kind={c.authorKind} style={{ padding: 12, borderRadius: 6, borderLeft: `3px solid ${KIND_COLOR[c.authorKind]}`, background: "var(--surface-1)" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)" }}>
                  {c.authorKind === "user" ? c.authorName : `${c.authorKind} · ${c.authorName}`}
                  {c.sourceFile ? ` · from ${c.sourceFile}` : ""} · {formatRelativeTime(c.createdAt)}
                </div>
                <TaskMarkdown>{c.body}</TaskMarkdown>
              </article>
            ))}
          </section>
          <section aria-label="Composer" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <MarkdownField value={draft} onChange={setDraft} ariaLabel="Comment" toolbar={false} minRows={6} autoFocus={focusComposer} placeholder={agent ? `@${agent.name} · markdown supported` : "markdown supported"} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <TaskAttachments items={attachments} onChange={setAttachments} folder={false} />
              <div style={{ display: "flex", gap: 8 }}>
              <Btn
                variant="frame"
                icon="refresh"
                disabled={!hasBody || !finished || comment.isPending}
                title={finished ? undefined : "Only a finished Task can be re-assigned"}
                onClick={() => comment.mutate(true)}
              >
                Comment &amp; re-assign
              </Btn>
              <Btn variant="primary" icon="pencil" disabled={!hasBody || comment.isPending} onClick={() => comment.mutate(false)}>
                Comment
              </Btn>
              </div>
            </div>
            <FormErrorBox error={message(comment.error) ?? message(move.error)} />
          </section>
        </>
      ) : null}
    </aside>
  );
}
