import { describe, expect, it } from "vitest";
import {
  CODEX_SETUP_VALUE,
  isCodexSetup,
  modelLabels,
  needsCodexSetup,
  parseModelId,
  shortModel,
  usableModels,
} from "../src/workspace/models";
import type { CodexAuthState, ModelOption } from "../src/state/useServer";

describe("model IDs", () => {
  it("shortens bare and qualified Claude IDs consistently, including dated long-context models", () => {
    expect(shortModel("anthropic/claude-opus-4-6")).toBe(shortModel("claude-opus-4-6"));
    expect(parseModelId("anthropic/claude-opus-4-6-20260501[1m]")).toEqual({
      id: "anthropic/claude-opus-4-6-20260501[1m]",
      provider: "anthropic",
      date: "20260501",
      short: "opus 4.6 [1m]",
    });
  });

  it("only adds provider and date to labels that collide", () => {
    const ids = [
      "anthropic/claude-opus-4-6-20260401",
      "anthropic/claude-opus-4-6-20260501",
      "other/claude-opus-4-6",
      "claude-opus-4-6",
      "provider/gpt-5.6-sol",
    ];
    expect(modelLabels(ids)).toEqual(
      ids.map((id, i) => ({
        id,
        label: [
          "opus 4.6 (anthropic, 20260401)",
          "opus 4.6 (anthropic, 20260501)",
          "opus 4.6 (other)",
          "opus 4.6",
          "gpt 5.6 sol",
        ][i],
      })),
    );
  });
});

it("gates native Codex by authentication, not by the Pi provider prefix", () => {
  const options = [
    { id: "gpt-5.6", backend: "codex" },
    { id: "openai-codex/gpt-5.6", backend: "pi" },
  ].map((option) => ({ ...option, label: option.id })) as ModelOption[];
  const signedOut: CodexAuthState = {
    cliAvailable: true,
    authenticated: false,
    status: "unauthenticated",
    checkedAt: 0,
  };
  expect(usableModels(options, null)).toBe(options);
  expect(usableModels(options, { ...signedOut, authenticated: true })).toBe(options);
  expect(usableModels(options, signedOut)).toEqual([options[1]]);
  expect(needsCodexSetup(signedOut)).toBe(true);
  expect(needsCodexSetup({ ...signedOut, cliAvailable: false })).toBe(false);
  expect(isCodexSetup(CODEX_SETUP_VALUE)).toBe(true);
  expect(isCodexSetup(options[1].id)).toBe(false);
});
