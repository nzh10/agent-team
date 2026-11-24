import { useEffect, useState } from "react";
import type { UiDialogAnswer, UiDialogRequest } from "../state/useServer";

import { DialogFrame } from "./DialogFrame";

// A Pi extension is blocked until this answer reaches it. The server owns
// resolution: after one answer the controls stay disabled until its
// ui_dialog_resolved broadcast closes the dialog on every client.
export function UiDialogModal({
  dialog,
  onRespond,
}: {
  dialog: UiDialogRequest;
  onRespond: (dialog: UiDialogRequest, answer: UiDialogAnswer) => boolean;
}) {
  const [value, setValue] = useState(dialog.prefill ?? "");
  const [answered, setAnswered] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const respond = (answer: UiDialogAnswer) => {
    if (answered) return;
    if (onRespond(dialog, answer)) setAnswered(true);
  };
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remainingMs = Math.max(0, dialog.expiresAt - now);
  const remaining = Math.ceil(remainingMs / 1000);
  const cancel = (
    <button
      type="button"
      className="btn-secondary"
      disabled={answered}
      onClick={() => respond({ cancelled: true })}
    >
      Cancel
    </button>
  );

  return (
    <DialogFrame
      title={dialog.title}
      titleAside={
        <span
          className={`ui-dialog-countdown${remainingMs === 0 ? " expired" : ""}`}
          aria-label="Time remaining"
        >
          {remainingMs > 0 ? `${remaining}s remaining` : "expired"}
        </span>
      }
      className={`ui-dialog ui-dialog-${dialog.method}`}
      overlayClass="ui-dialog-overlay"
      priority={2}
      onClose={() => respond({ cancelled: true })}
      closeOnOverlay={false}
      initialFocus="input, textarea, [data-dialog-primary]"
    >
      {dialog.message && <p className="dialog-body ui-dialog-message">{dialog.message}</p>}

      {dialog.method === "select" && (
        <div className="ui-dialog-options" role="group" aria-label="Choices">
          {(dialog.options ?? []).map((option, index) => (
            <button
              key={`${index}:${option}`}
              type="button"
              className="ui-dialog-option"
              data-dialog-primary={index === 0 ? "" : undefined}
              disabled={answered}
              onClick={() => respond({ value: option })}
            >
              {option}
            </button>
          ))}
        </div>
      )}

      {dialog.method === "confirm" && (
        <div className="dialog-actions">
          {cancel}
          <button
            type="button"
            className="btn-primary"
            data-dialog-primary
            disabled={answered}
            onClick={() => respond({ confirmed: true })}
          >
            Confirm
          </button>
        </div>
      )}

      {(dialog.method === "input" || dialog.method === "editor") && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            respond({ value });
          }}
        >
          <label className="dialog-field">
            <span>Response</span>
            {dialog.method === "input" ? (
              <input
                value={value}
                placeholder={dialog.placeholder}
                disabled={answered}
                onChange={(event) => setValue(event.target.value)}
              />
            ) : (
              <textarea
                className="ui-dialog-editor"
                value={value}
                placeholder={dialog.placeholder}
                disabled={answered}
                rows={8}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </label>
          <div className="dialog-actions">
            {cancel}
            <button type="submit" className="btn-primary" disabled={answered}>
              Submit
            </button>
          </div>
        </form>
      )}

      {dialog.method === "select" && <div className="dialog-actions">{cancel}</div>}
      {answered && (
        <div className="ui-dialog-sent" role="status">
          Answer sent; waiting for the session…
        </div>
      )}
    </DialogFrame>
  );
}
