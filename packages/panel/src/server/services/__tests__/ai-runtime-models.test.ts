import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../claude-cli", () => ({
  runCli: vi.fn(),
}));

const { runCli } = await import("../claude-cli");
const {
  clearAiRuntimeModelCache,
  listAiRuntimeModels,
  parseCursorModelList,
  parsePiModelList,
  parsePlainModelList,
} = await import("../ai-runtime-models");

describe("AI runtime model discovery", () => {
  beforeEach(() => {
    clearAiRuntimeModelCache();
    vi.mocked(runCli).mockReset();
  });

  it("parses Cursor's id-label model list", () => {
    expect(
      parseCursorModelList(`
Available models

auto - Auto
gpt-5.5-extra-high - GPT-5.5 Extra High
not a model line
`),
    ).toEqual([
      { id: "auto", label: "Auto" },
      { id: "gpt-5.5-extra-high", label: "GPT-5.5 Extra High" },
    ]);
  });

  it("parses OpenCode's one-model-per-line output", () => {
    expect(
      parsePlainModelList(`
opencode/big-pickle
anthropic/claude-sonnet-4-5
bad model with spaces
`),
    ).toEqual([
      { id: "opencode/big-pickle", label: "opencode/big-pickle" },
      {
        id: "anthropic/claude-sonnet-4-5",
        label: "anthropic/claude-sonnet-4-5",
      },
    ]);
  });

  it("parses Pi's padded --list-models table and skips the header row", () => {
    // Captured shape from @earendil-works/pi-coding-agent dist/cli/list-models.js
    // (padEnd columns joined with two spaces). parsePlainModelList drops every
    // line because of the spaces between columns.
    const captured = `provider    model                        context  max-out  thinking  images
anthropic   claude-haiku-4-5             200K     64K      yes       yes   
anthropic   claude-opus-4-5              200K     32K      yes       yes   
anthropic   claude-sonnet-4-5            200K     64K      yes       yes   
google      gemini-2.5-flash             1M       65.5K    yes       yes   
google      gemini-2.5-pro               1M       65.5K    yes       yes   
openai      gpt-4o                       128K     16.4K    no        yes   
openai      gpt-5.5                      400K     128K     yes       no    
openrouter  anthropic/claude-sonnet-4.5  200K     64K      yes       yes   
No models matching "zzz"
`;
    expect(parsePiModelList(captured)).toEqual([
      { id: "anthropic/claude-haiku-4-5", label: "anthropic/claude-haiku-4-5" },
      { id: "anthropic/claude-opus-4-5", label: "anthropic/claude-opus-4-5" },
      {
        id: "anthropic/claude-sonnet-4-5",
        label: "anthropic/claude-sonnet-4-5",
      },
      { id: "google/gemini-2.5-flash", label: "google/gemini-2.5-flash" },
      { id: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
      { id: "openai/gpt-4o", label: "openai/gpt-4o" },
      { id: "openai/gpt-5.5", label: "openai/gpt-5.5" },
      {
        id: "openrouter/anthropic/claude-sonnet-4.5",
        label: "openrouter/anthropic/claude-sonnet-4.5",
      },
    ]);
    // Header must not become provider/model.
    expect(
      parsePiModelList(captured).some((m) => m.id === "provider/model"),
    ).toBe(false);
  });

  it("parses Pi rows that have only a single space between full-width columns", () => {
    // Defensive: still accept a single-space gap if pad/join ever collapses.
    const exactWidth = [
      "provider model              context max-out thinking images",
      "anthropic claude-sonnet-4-5 200K    64K     yes      yes",
    ].join("\n");
    expect(parsePiModelList(exactWidth)).toEqual([
      {
        id: "anthropic/claude-sonnet-4-5",
        label: "anthropic/claude-sonnet-4-5",
      },
    ]);
  });

  it("uses live Pi models when pi --list-models succeeds", async () => {
    vi.mocked(runCli).mockResolvedValueOnce(
      [
        "provider   model               context  max-out  thinking  images",
        "anthropic  claude-sonnet-4-5    200K     64K      yes       yes",
      ].join("\n"),
    );

    await expect(listAiRuntimeModels("pi")).resolves.toEqual({
      harness: "pi",
      source: "cli",
      models: [
        {
          id: "anthropic/claude-sonnet-4-5",
          label: "anthropic/claude-sonnet-4-5",
        },
      ],
    });
    expect(runCli).toHaveBeenCalledWith(
      "pi",
      ["--list-models"],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("uses live Cursor models when the CLI list succeeds", async () => {
    vi.mocked(runCli).mockResolvedValueOnce("composer-2.5 - Composer 2.5\n");

    await expect(listAiRuntimeModels("cursor-cli")).resolves.toEqual({
      harness: "cursor-cli",
      source: "cli",
      models: [{ id: "composer-2.5", label: "Composer 2.5" }],
    });
  });

  it("falls back to the catalog when live discovery fails", async () => {
    vi.mocked(runCli).mockRejectedValueOnce(new Error("missing cursor-agent sk-secret123456"));

    const result = await listAiRuntimeModels("cursor-cli");

    expect(result.harness).toBe("cursor-cli");
    expect(result.source).toBe("catalog");
    expect(result.error).toBe("model discovery failed");
    expect(result.models.some((model) => model.id === "composer-2.5")).toBe(true);
  });

  it("falls back to the Pi catalog when live discovery fails", async () => {
    vi.mocked(runCli).mockRejectedValueOnce(new Error("pi not found"));

    const result = await listAiRuntimeModels("pi");

    expect(result.harness).toBe("pi");
    expect(result.source).toBe("catalog");
    expect(result.error).toBe("model discovery failed");
    expect(
      result.models.some((model) => model.id === "anthropic/claude-sonnet-4-5"),
    ).toBe(true);
  });

  it("dedupes concurrent live discovery for the same core", async () => {
    vi.mocked(runCli).mockResolvedValueOnce("composer-2.5 - Composer 2.5\n");

    await Promise.all([
      listAiRuntimeModels("cursor-cli"),
      listAiRuntimeModels("cursor-cli"),
    ]);

    expect(runCli).toHaveBeenCalledTimes(1);
  });
});
