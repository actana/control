import { describe, expect, it } from "vitest";
import { Route } from "~/routes/__root";

describe("root route head", () => {
  it("viewport meta covers the notch (viewport-fit=cover) so safe-area insets apply", () => {
    const head = (Route.options.head as () => { meta: Record<string, string>[] })();
    const viewport = head.meta.find((m) => m.name === "viewport");
    expect(viewport?.content).toBe("width=device-width, initial-scale=1, viewport-fit=cover");
  });
});
