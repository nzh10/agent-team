import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { AddAgentDialog, CodexSetupDialog, CODEX_LOGIN_COMMAND } from "../../src/workspace/dialogs";
import { CODEX_SETUP_VALUE } from "../../src/workspace/models";
import type { CodexAuthState, ModelOption } from "../../src/state/useServer";
import "../../src/styles.css";

const rect = (el: Element) => el.getBoundingClientRect();
const get = <T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string) => {
  const el = root.querySelector<T>(selector);
  expect(el, selector).not.toBeNull();
  return el!;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("displays the italic Codex hint, opens the stacked setup modal cleanly on desktop and mobile, and unlocks live", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });

  const piModels: ModelOption[] = [
    { id: "openai-codex/gpt-5.4", label: "GPT-5.4 (Pi)", backend: "pi" },
  ];
  const allModels: ModelOption[] = [
    ...piModels,
    { id: "gpt-6-astra", label: "GPT-6 Astra", backend: "codex", effortLevels: ["low", "high"] },
  ];

  function Harness() {
    const [codexAuth, setCodexAuth] = useState<CodexAuthState>({
      cliAvailable: true,
      authenticated: false,
      status: "unauthenticated",
      accountType: null,
      checkedAt: 1,
    });
    const [models, setModels] = useState<ModelOption[]>(piModels);
    const [setupOpen, setSetupOpen] = useState(false);
    const [rechecking, setRechecking] = useState(false);

    const handleRecheck = () => {
      setRechecking(true);
      setTimeout(() => {
        setCodexAuth({
          cliAvailable: true,
          authenticated: true,
          status: "authenticated",
          accountType: "chatgpt",
          checkedAt: 2,
        });
        setModels(allModels);
        setRechecking(false);
      }, 20);
    };

    return (
      <>
        <AddAgentDialog
          presets={[{ name: "Coder", avatar: "C", color: "#528bff", model: "gpt-6-astra" }]}
          models={models}
          codexAuth={codexAuth}
          onOpenCodexSetup={() => setSetupOpen(true)}
          suspended={setupOpen}
          onClose={() => {}}
          onAdd={() => {}}
        />
        {setupOpen && (
          <CodexSetupDialog
            codexAuth={codexAuth}
            rechecking={rechecking}
            onRecheck={handleRecheck}
            onClose={() => setSetupOpen(false)}
          />
        )}
      </>
    );
  }

  for (const [w, h] of [
    [1100, 800],
    [390, 800],
  ] as const) {
    await page.viewport(w, h);
    const view = render(<Harness />);
    const select = get<HTMLSelectElement>(document, "#add-agent-model");
    const setupOpt = get<HTMLOptionElement>(select, `option[value="${CODEX_SETUP_VALUE}"]`);
    expect(getComputedStyle(setupOpt).fontStyle).toBe("italic");
    const hintBtn = get<HTMLButtonElement>(document, ".codex-auth-hint");
    expect(getComputedStyle(hintBtn).fontStyle).toBe("italic");
    expect(select.querySelector('option[value="gpt-6-astra"]')).toBeNull();
    expect(select.querySelector('option[value="openai-codex/gpt-5.4"]')).not.toBeNull();

    // Open CodexSetupDialog on top of AddAgentDialog.
    fireEvent.click(hintBtn);
    const setupOverlay = get(document, ".dialog-codex-setup-overlay");
    const setupDialog = get(document, ".dialog-codex-setup");
    expect(Number(getComputedStyle(setupOverlay).zIndex)).toBeGreaterThan(
      Number(getComputedStyle(get(document, ".dialog-overlay")).zIndex),
    );
    const cmdBox = get(setupDialog, ".codex-cmd-box");
    const cmdCode = get(cmdBox, ".codex-cmd-code");
    const copyBtn = get(cmdBox, ".codex-copy-btn");
    expect(cmdCode.textContent).toBe(CODEX_LOGIN_COMMAND);
    expect(rect(setupDialog).left).toBeGreaterThanOrEqual(0);
    expect(rect(setupDialog).right).toBeLessThanOrEqual(w);
    expect(rect(copyBtn).left).toBeGreaterThanOrEqual(rect(cmdCode).right - 1);
    expect(rect(copyBtn).right).toBeLessThanOrEqual(rect(setupDialog).right);

    fireEvent.click(copyBtn);
    await expect.poll(() => copyBtn.textContent).toBe("Copied");

    if (w === 1100) {
      // Trigger Re-check and verify live modal close + model list update.
      fireEvent.click(view.getByRole("button", { name: "Re-check" }));
      await expect.poll(() => document.querySelector(".dialog-codex-setup")).toBeNull();
      expect(select.querySelector('option[value="gpt-6-astra"]')).not.toBeNull();
    }
    cleanup();
  }
});
