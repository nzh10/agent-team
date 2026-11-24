// A new agent: its model, and the reasoning effort the model takes.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { AddAgentDialog, CodexSetupDialog, CODEX_LOGIN_COMMAND } from "../src/workspace/dialogs";
import { CODEX_SETUP_VALUE } from "../src/workspace/models";
import type { AgentPreset, CodexAuthState, ModelOption } from "../src/state/useServer";

const models: ModelOption[] = [
  {
    id: "anthropic/claude-opus-5-5",
    label: "Opus 5.5",
    backend: "pi",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "google/gemini-4-argon",
    label: "Gemini 4 Argon",
    backend: "pi",
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  { id: "openai/gpt-5.5", label: "GPT 5.5", backend: "pi", effortLevels: ["off"] },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    backend: "codex",
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
];

const unauthedCodex: CodexAuthState = {
  cliAvailable: true,
  authenticated: false,
  status: "unauthenticated",
  accountType: null,
  checkedAt: 1,
};

const dialog = (
  presets: AgentPreset[] = [{ name: "Kisara", avatar: "k.jpg", color: "#D8A0D8" }],
) => {
  const onAdd = vi.fn();
  const utils = render(
    <AddAgentDialog presets={presets} models={models} onClose={() => {}} onAdd={onAdd} />,
  );
  const model = () => utils.getByText("Model").parentElement!.querySelector("select")!;
  const effort = () => utils.queryByLabelText("Reasoning effort") as HTMLSelectElement | null;
  const levels = () => [...effort()!.options].map((o) => o.textContent);
  return { ...utils, onAdd, model, effort, levels };
};

describe("adding an agent", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("offers the effort levels of the model chosen, its default first", () => {
    const d = dialog();
    expect(d.levels()).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    fireEvent.change(d.model(), { target: { value: "google/gemini-4-argon" } });
    expect(d.levels()).toEqual(["default (medium)", "low", "medium", "high"]);
    fireEvent.change(d.model(), { target: { value: "openai/gpt-5.5" } });
    expect(d.effort()).toBeNull();
  });

  it("adds it at the effort chosen, kept across models that have it", () => {
    const d = dialog();
    fireEvent.change(d.effort()!, { target: { value: "high" } });
    fireEvent.change(d.model(), { target: { value: "google/gemini-4-argon" } });
    expect(d.effort()!.value).toBe("high");
    fireEvent.change(d.model(), { target: { value: "anthropic/claude-opus-5-5" } });
    fireEvent.change(d.effort()!, { target: { value: "max" } });
    fireEvent.change(d.model(), { target: { value: "google/gemini-4-argon" } });
    expect(d.effort()!.value).toBe("");
    fireEvent.change(d.effort()!, { target: { value: "low" } });
    fireEvent.click(d.getByText("Add"));
    expect(d.onAdd).toHaveBeenCalledWith(
      "Kisara",
      "google/gemini-4-argon",
      "k.jpg",
      "#D8A0D8",
      "low",
    );
  });

  it("selects available preset defaults on open and on click", () => {
    const base = { avatar: "a", color: "red" };
    const d = dialog([
      { ...base, name: "A", model: models[1].id, effort: "high" },
      { ...base, name: "B", model: models[0].id, effort: "max" },
      { ...base, name: "C", model: "missing", effort: "low" },
      { ...base, name: "D", model: models[1].id, effort: "max" },
    ]);
    expect([d.model().value, d.effort()!.value]).toEqual([models[1].id, "high"]);
    fireEvent.click(d.getByText("B"));
    expect([d.model().value, d.effort()!.value]).toEqual([models[0].id, "max"]);
    fireEvent.click(d.getByText("C"));
    expect([d.model().value, d.effort()!.value]).toEqual([models[0].id, ""]);
    fireEvent.click(d.getByText("D"));
    expect([d.model().value, d.effort()!.value]).toEqual([models[1].id, ""]);
  });

  it("groups the models by backend", () => {
    const d = dialog();
    const groups = [...d.model().querySelectorAll("optgroup")].map((g) => [
      g.label,
      [...g.querySelectorAll("option")].map((o) => o.value),
    ]);
    expect(groups).toEqual([
      ["Pi", ["anthropic/claude-opus-5-5", "google/gemini-4-argon", "openai/gpt-5.5"]],
      ["Codex", ["gpt-6-astra"]],
    ]);
  });

  it("leaves the effort to the model when none is chosen", () => {
    const d = dialog();
    fireEvent.click(d.getByText("Add"));
    expect(d.onAdd.mock.calls[0][4]).toBeUndefined();
  });

  it("gates unauthenticated Codex models, keeps Pi openai-codex/* selectable, and opens Codex setup", () => {
    const onOpenSetup = vi.fn();
    const withPiCodex: ModelOption[] = [
      ...models,
      { id: "openai-codex/gpt-5.4", label: "GPT-5.4 (Pi)", backend: "pi" },
    ];
    const utils = render(
      <AddAgentDialog
        presets={[{ name: "Lead", avatar: "L", color: "#528bff", model: "gpt-6-astra" }]}
        models={withPiCodex}
        codexAuth={unauthedCodex}
        onOpenCodexSetup={onOpenSetup}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    const select = utils.getByText("Model").parentElement!.querySelector("select")!;
    const groups = [...select.querySelectorAll("optgroup")].map((g) => [
      g.label,
      [...g.querySelectorAll("option")].map((o) => [o.value, o.textContent]),
    ]);
    expect(groups).toEqual([
      [
        "Pi",
        [
          ["anthropic/claude-opus-5-5", "Opus 5.5"],
          ["google/gemini-4-argon", "Gemini 4 Argon"],
          ["openai/gpt-5.5", "GPT 5.5"],
          ["openai-codex/gpt-5.4", "GPT-5.4 (Pi)"],
        ],
      ],
      ["Codex", [[CODEX_SETUP_VALUE, "Codex (not signed in)"]]],
    ]);
    expect(select.value).toBe("anthropic/claude-opus-5-5");

    fireEvent.change(select, { target: { value: CODEX_SETUP_VALUE } });
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
    expect(select.value).toBe("anthropic/claude-opus-5-5");

    fireEvent.click(utils.getByRole("button", { name: "Sign in to Codex…" }));
    expect(onOpenSetup).toHaveBeenCalledTimes(2);
  });

  it("hides the Codex hint when the CLI is unavailable and unlocks live when authenticated", () => {
    const utils = render(
      <AddAgentDialog
        presets={[{ name: "Kisara", avatar: "k", color: "#fff" }]}
        models={models.filter((m) => m.backend === "codex")}
        codexAuth={{
          cliAvailable: false,
          authenticated: false,
          status: "unavailable",
          checkedAt: 1,
        }}
        onOpenCodexSetup={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(utils.queryByText("Codex (not signed in)")).toBeNull();
    expect((utils.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);

    // Unauthenticated with CLI available, then live unlock refreshes selectable models.
    utils.rerender(
      <AddAgentDialog
        presets={[{ name: "Kisara", avatar: "k", color: "#fff" }]}
        models={[]}
        codexAuth={unauthedCodex}
        onOpenCodexSetup={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(utils.getByText("Codex (not signed in)")).toBeTruthy();
    expect((utils.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);

    utils.rerender(
      <AddAgentDialog
        presets={[{ name: "Kisara", avatar: "k", color: "#fff" }]}
        models={models.filter((m) => m.backend === "codex")}
        codexAuth={{ ...unauthedCodex, authenticated: true, status: "authenticated" }}
        onOpenCodexSetup={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(utils.queryByText("Codex (not signed in)")).toBeNull();
    const select = utils.getByText("Model").parentElement!.querySelector("select")!;
    expect(select.value).toBe("gpt-6-astra");
    expect((utils.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("CodexSetupDialog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("copies npx codex login and handles Re-check state transitions and auto-close", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onRecheck = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <CodexSetupDialog
        codexAuth={unauthedCodex}
        rechecking={false}
        onRecheck={onRecheck}
        onClose={onClose}
      />,
    );

    expect(view.getByText(CODEX_LOGIN_COMMAND)).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy" }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(CODEX_LOGIN_COMMAND);
    expect(view.getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(view.getByRole("button", { name: "Copy" })).toBeTruthy();

    // Start re-check, remain unauthenticated, and see feedback.
    fireEvent.click(view.getByRole("button", { name: "Re-check" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
    view.rerender(
      <CodexSetupDialog
        codexAuth={unauthedCodex}
        rechecking={true}
        onRecheck={onRecheck}
        onClose={onClose}
      />,
    );
    const checkingBtn = view.getByRole("button", { name: "Checking…" }) as HTMLButtonElement;
    expect(checkingBtn.disabled).toBe(true);

    view.rerender(
      <CodexSetupDialog
        codexAuth={{ ...unauthedCodex, status: "error", error: "daemon busy" }}
        rechecking={false}
        onRecheck={onRecheck}
        onClose={onClose}
      />,
    );
    expect(view.getByRole("status").textContent).toContain("Check failed: daemon busy");
    expect(onClose).not.toHaveBeenCalled();

    // Retry re-check and succeed: closes modal cleanly.
    fireEvent.click(view.getByRole("button", { name: "Re-check" }));
    view.rerender(
      <CodexSetupDialog
        codexAuth={unauthedCodex}
        rechecking={true}
        onRecheck={onRecheck}
        onClose={onClose}
      />,
    );
    view.rerender(
      <CodexSetupDialog
        codexAuth={{ ...unauthedCodex, authenticated: true, status: "authenticated" }}
        rechecking={false}
        onRecheck={onRecheck}
        onClose={onClose}
      />,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the stacked setup modal on Escape when AddAgentDialog is suspended", () => {
    const closeAdd = vi.fn();
    const closeSetup = vi.fn();
    render(
      <>
        <AddAgentDialog
          presets={[{ name: "A", avatar: "a", color: "#fff" }]}
          models={models}
          codexAuth={unauthedCodex}
          suspended
          onOpenCodexSetup={() => {}}
          onClose={closeAdd}
          onAdd={() => {}}
        />
        <CodexSetupDialog
          codexAuth={unauthedCodex}
          rechecking={false}
          onRecheck={() => {}}
          onClose={closeSetup}
        />
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeSetup).toHaveBeenCalledTimes(1);
    expect(closeAdd).not.toHaveBeenCalled();
  });

  it("reports copy failure honestly instead of showing Copied when clipboard and execCommand fail", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) },
      configurable: true,
    });
    document.execCommand = vi.fn().mockReturnValue(false);
    try {
      const view = render(
        <CodexSetupDialog
          codexAuth={unauthedCodex}
          rechecking={false}
          onRecheck={() => {}}
          onClose={() => {}}
        />,
      );
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Copy" }));
        await Promise.resolve();
      });
      expect(view.queryByRole("button", { name: "Copied" })).toBeNull();
      expect(view.getByRole("button", { name: "Copy failed" })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(view.getByRole("button", { name: "Copy" })).toBeTruthy();
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("resets a selected native Codex model when codexAuth transitions authenticated -> unauthenticated", () => {
    const view = render(
      <AddAgentDialog
        presets={[{ name: "CodexLead", model: "gpt-6-astra", avatar: "c", color: "#fff" }]}
        models={models}
        codexAuth={{
          cliAvailable: true,
          authenticated: true,
          status: "authenticated",
          accountType: "chatgpt",
          checkedAt: 1,
        }}
        onOpenCodexSetup={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    const select = view.getByLabelText("Model") as HTMLSelectElement;
    expect(select.value).toBe("gpt-6-astra");

    const piOnly = models.filter((m) => m.backend !== "codex");
    view.rerender(
      <AddAgentDialog
        presets={[{ name: "CodexLead", model: "gpt-6-astra", avatar: "c", color: "#fff" }]}
        models={piOnly}
        codexAuth={unauthedCodex}
        onOpenCodexSetup={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    expect((view.getByLabelText("Model") as HTMLSelectElement).value).toBe(
      "anthropic/claude-opus-5-5",
    );
  });
});
