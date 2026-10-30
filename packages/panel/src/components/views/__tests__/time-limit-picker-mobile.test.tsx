// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { TimeLimitPicker } from "../TimeLimitPicker";
import type { TaskTimeoutMinutes } from "~/shared/tasks";

function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return { media: query, matches: max ? width <= Number(max[1]) : false, addEventListener: () => {}, removeEventListener: () => {} };
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ onValid }: { onValid?: (v: boolean) => void }) {
  const [v, setV] = useState<TaskTimeoutMinutes>(60);
  return <TimeLimitPicker value={v} onChange={setV} onValidChange={onValid} />;
}

describe("TimeLimitPicker on a phone", () => {
  it("Custom shows a numeric-keypad field, accepts 90 and shows 90 min", () => {
    stubWidth(390);
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: /Custom/ }));
    const input = screen.getByLabelText("Minutes") as HTMLInputElement;
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("pattern")).toBe("[0-9]*");
    expect(input.getAttribute("enterkeyhint")).toBe("done");
    expect(screen.getByText(/1 to 43200 \(30 days\)/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "90" } });
    expect(screen.getByText(/Shown on the Task as 90 min/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["0", "43201", "1.5"])("rejects %s", (bad) => {
    stubWidth(390);
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    fireEvent.click(screen.getByRole("radio", { name: /Custom/ }));
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: bad } });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onValid).toHaveBeenLastCalledWith(false);
  });

  it("keeps the number input on desktop", () => {
    stubWidth(1280);
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: /Custom/ }));
    expect((screen.getByLabelText("Minutes") as HTMLInputElement).type).toBe("number");
  });
});
