import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DialogFrame } from "../src/workspace/DialogFrame";
import { UiDialogModal } from "../src/workspace/UiDialogModal";
import { selectUiDialogs, uiDialogKey } from "../src/state/uiDialogs";
import type { UiDialogRequest } from "../src/state/useServer";

const makeDialog = (requestId: string, workspaceId = "w", createdAt = 1): UiDialogRequest => ({
  requestId,
  workspaceId,
  agentId: "a",
  processGeneration: 1,
  method: "input",
  title: "Pi prompt",
  createdAt,
  timeoutMs: 60_000,
  expiresAt: Date.now() + 60_000,
});

it("selects the earliest request per scope and counts distinct other sessions", () => {
  const current = makeDialog("b"),
    tied = makeDialog("a");
  const other = makeDialog("c", "x", 0),
    later = makeDialog("d", "y", 3);
  expect(selectUiDialogs([later, current, tied, other, makeDialog("e", "x")], "w")).toEqual({
    currentDialog: tied,
    otherDialog: other,
    otherDialogCount: 2,
  });
  expect(uiDialogKey(tied)).not.toBe(uiDialogKey({ ...tied, processGeneration: 2 }));
});

it("routes Escape only to the blocking Pi dialog and ignores overlay and IME dismissal", () => {
  const onClose = vi.fn();
  const onRespond = vi.fn(() => true);
  const dialog = makeDialog("r");
  const underlying = (
    <DialogFrame title="App dialog" onClose={onClose}>
      <button>Continue</button>
    </DialogFrame>
  );
  const view = render(
    <>
      {underlying}
      <UiDialogModal dialog={dialog} onRespond={onRespond} />
    </>,
  );
  const modal = screen.getByRole("dialog", { name: "Pi prompt" });
  expect(modal.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Response" }));
  fireEvent.click(modal.parentElement!);
  fireEvent.keyDown(document.activeElement!, { key: "Escape", isComposing: true });
  expect(onRespond).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(onRespond).toHaveBeenCalledExactlyOnceWith(dialog, { cancelled: true });
  expect(onClose).not.toHaveBeenCalled();
  view.rerender(<>{underlying}</>);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
});

it("does not focus or dismiss a suspended frame until it resumes", () => {
  const close = vi.fn();
  const frame = (suspended: boolean) => (
    <DialogFrame title="Setup" onClose={close} suspended={suspended}>
      <input aria-label="Name" data-dialog-focus />
    </DialogFrame>
  );
  const view = render(frame(true));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  view.rerender(frame(false));
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
  fireEvent.click(screen.getByRole("dialog", { name: "Setup" }).parentElement!);
  expect(close).toHaveBeenCalledTimes(1);
});
