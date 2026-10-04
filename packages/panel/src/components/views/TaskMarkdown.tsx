import ReactMarkdown from "react-markdown";

/**
 * Markdown from a Task: a description, or a comment an agent wrote. Images are
 * dropped, not loaded: the Panel sets no content security policy, so an image URL
 * in agent-written text would make the operator's browser fetch it.
 */
export function TaskMarkdown({ children }: { children: string }) {
  return (
    <div className="task-markdown">
      <ReactMarkdown disallowedElements={["img"]}>{children}</ReactMarkdown>
    </div>
  );
}
