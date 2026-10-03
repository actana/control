import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown from a file in the Shared folder (#565): a report an agent wrote, so nothing in it is trusted.
 *
 * - **No raw HTML.** react-markdown builds React elements from the parsed tree and has no HTML pass here (no `rehype-raw`),
 *   and `skipHtml` drops an HTML node outright, so `<script>`, `<img onerror>` and `<iframe>` are not rendered, nor shown.
 * - **No images and no embeds.** The Panel sets no content security policy, so an image URL in agent-written text would
 *   make the operator's browser fetch it. Images are dropped, as in {@link TaskMarkdown}.
 * - **Links** keep only `http:`, `https:` and `mailto:` (a `javascript:` or `data:` target becomes no link), and open in a
 *   new tab with `noopener noreferrer` so the page that opened them is not reachable.
 */
const SAFE_URL = /^(https?:|mailto:)/i;

export function safeMarkdownUrl(url: string): string {
  return SAFE_URL.test(url.trim()) ? url : "";
}

const components: Components = {
  a({ href, children }) {
    if (!href) return <>{children}</>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  },
  // GFM task lists render a checkbox; it is a picture of the box in the file, not a control.
  input({ checked }) {
    return <input type="checkbox" checked={!!checked} readOnly disabled aria-label={checked ? "done" : "not done"} />;
  },
};

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="task-markdown" data-testid="markdown-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]} urlTransform={safeMarkdownUrl} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
