/**
 * The guides `get_guide` serves (#952): how to hand a Task to an Agent and wait for it, written once in the Panel
 * (`guides/*.md`) so every MCP caller learns it from the Panel itself and changing the recipe is a Panel change only.
 *
 * The Markdown is compiled into the bundle by Vite, the way the Postgres migrations are (`db/pg-migrations-bundle.ts`),
 * so a running Panel needs no guides folder beside it.
 */

const files = import.meta.glob("./guides/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** Each topic with the line the topic list shows. A new topic is one entry here and one file in `guides/`. */
const TOPIC_SUMMARIES = {
  overview: "what a Task is and the short recipe",
  "hand-off": "choose a Core and an Agent, create or assign a Task",
  waiting: "wait on watch.url with `actana task wait` or a curl loop",
  states: "each sessionState and what to do about it",
  blocked: "queued, refused or stuck Tasks, and when not to stop one",
  comments: "comment on a Task, comment and re-assign",
} as const;

export type GuideTopic = keyof typeof TOPIC_SUMMARIES;

export const GUIDE_TOPICS = Object.keys(TOPIC_SUMMARIES) as [GuideTopic, ...GuideTopic[]];

function fileFor(topic: GuideTopic): string {
  const text = files[`./guides/${topic}.md`];
  if (text === undefined) throw new Error(`guide file missing: ${topic}`);
  return text;
}

/** The Markdown for one topic. With no topic: the overview, then the list of topics. */
export function guideMarkdown(topic?: GuideTopic): string {
  if (topic !== undefined && !GUIDE_TOPICS.includes(topic)) {
    throw new Error(`unknown guide topic ${String(topic)}; valid topics: ${GUIDE_TOPICS.join(", ")} (overview is the default)`);
  }
  if (topic !== undefined && topic !== "overview") return fileFor(topic);
  const list = GUIDE_TOPICS.map((t) => `- \`${t}\`: ${TOPIC_SUMMARIES[t]}`).join("\n");
  return `${fileFor("overview").trimEnd()}\n\n## Topics\n\nCall \`get_guide\` with a \`topic\`:\n\n${list}\n`;
}
