import { EventEmitter } from "node:events";
import type { HarnessQuestion } from "~/shared/harness-questions";

export type AppEvent =
  | { type: "session:created"; id: string }
  | { type: "session:updated"; id: string }
  | { type: "session:archived"; id: string }
  | { type: "session:restored"; id: string }
  | { type: "session:deleted"; id: string }
  | {
      type: "session:finished";
      id: string;
      sessionTitle: string;
    }
  | {
      type: "session:question";
      sessionId: string;
      questionId: string;
      questions: HarnessQuestion[];
    }
  | { type: "session:question-cleared"; sessionId: string }
  | { type: "prompt:submitted"; sessionId: string; snippet: string };

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
