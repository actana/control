import { describe, expect, it } from "vitest";

import { redactDockerArgs } from "../lib/postgres-fixture.mjs";

describe("redactDockerArgs", () => {
  it("hides the value of every --env and -e, keeping the variable name", () => {
    const args = [
      "run",
      "--env",
      "POSTGRES_PASSWORD=abc123",
      "-e",
      "AC_PANEL_DATABASE_URL=postgres://panel:abc123@pg:5432/panel",
      "--name",
      "x=y",
      "image",
    ];
    const shown = redactDockerArgs(args).join(" ");
    expect(shown).not.toContain("abc123");
    expect(shown).toContain("POSTGRES_PASSWORD=<redacted>");
    expect(shown).toContain("AC_PANEL_DATABASE_URL=<redacted>");
    expect(shown).toContain("--name x=y");
  });
});
