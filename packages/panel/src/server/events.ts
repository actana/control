import { EventEmitter } from "node:events";
import type { HarnessQuestion } from "~/shared/harness-questions";

export type AppEvent =
  | { type: "project:created"; id: string }
  | { type: "project:updated"; id: string }
  | { type: "project:deleted"; id: string }
  | { type: "group:created"; id: string }
  | { type: "group:updated"; id: string }
  | { type: "group:deleted"; id: string }
  | { type: "session:created"; id: string; projectId: string }
  | { type: "session:updated"; id: string; projectId: string }
  | { type: "session:archived"; id: string; projectId: string }
  | { type: "session:restored"; id: string; projectId: string }
  | { type: "session:deleted"; id: string; projectId: string }
  | {
      type: "session:finished";
      id: string;
      projectId: string;
      projectName: string;
      sessionTitle: string;
    }
  | {
      type: "session:question";
      sessionId: string;
      projectId: string;
      questionId: string;
      questions: HarnessQuestion[];
    }
  | { type: "session:question-cleared"; sessionId: string; projectId: string }
  | { type: "prompt:submitted"; sessionId: string; projectId: string; snippet: string };

class TypedEmitter {
  private inner = new EventEmitter();

  emit<K extends AppEvent["type"]>(type: K, payload: Omit<Extract<AppEvent, { type: K }>, "type">) {
    this.inner.emit("event", { type, ...payload });
    this.inner.emit(type, payload);
  }

  onAny(cb: (e: AppEvent) => void) {
    this.inner.on("event", cb);
    return () => this.inner.off("event", cb);
  }

  setMaxListeners(n: number) {
    this.inner.setMaxListeners(n);
  }
}

export const events = new TypedEmitter();
events.setMaxListeners(50);
