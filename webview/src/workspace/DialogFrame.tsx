import {
  useId,
  useLayoutEffect,
  useRef,
  type FormEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';
const stack: { frame: HTMLElement; priority: number; focus: () => void }[] = [];
const top = () =>
  stack.reduce<(typeof stack)[number] | undefined>(
    (best, dialog) => (!best || dialog.priority >= best.priority ? dialog : best),
    undefined,
  );

function syncStack() {
  const active = top();
  for (const entry of stack) {
    const isTop = entry === active;
    const overlay = entry.frame.parentElement!;
    overlay.toggleAttribute("inert", !isTop);
    if (isTop) {
      overlay.removeAttribute("aria-hidden");
      entry.frame.setAttribute("aria-modal", "true");
    } else {
      overlay.setAttribute("aria-hidden", "true");
      entry.frame.removeAttribute("aria-modal");
    }
  }
}

type DialogKeys = {
  onEscape: () => void;
  initialFocus?: string;
  suspended?: boolean;
  priority?: number;
};

function useDialogKeys(
  ref: RefObject<HTMLElement | null>,
  { onEscape, initialFocus = "[data-dialog-focus]", suspended, priority = 0 }: DialogKeys,
) {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useLayoutEffect(() => {
    if (suspended) return;
    const frame = ref.current!;
    const opener = document.activeElement;
    const focusable = () =>
      [...frame.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.closest("[hidden], [inert]"),
      );
    const entry = {
      frame,
      priority,
      focus: () => {
        const items = focusable();
        (items.find((item) => item.matches(initialFocus)) ?? items[0] ?? frame).focus();
      },
    };
    stack.push(entry);
    syncStack();
    if (top() === entry) entry.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || top() !== entry) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        escape.current();
      } else if (event.key === "Tab") {
        const items = focusable();
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (index === -1 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
          event.preventDefault();
          (items.at(event.shiftKey ? -1 : 0) ?? frame).focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      const wasTop = top() === entry;
      stack.splice(stack.indexOf(entry), 1);
      syncStack();
      if (!wasTop) return;
      const previous = top();
      if (previous) previous.focus();
      else if (opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]"))
        opener.focus();
    };
  }, [ref, initialFocus, suspended, priority]);
}

export function DialogFrame({
  title,
  titleAside,
  onClose,
  onEscape = onClose,
  closeOnOverlay = true,
  initialFocus,
  suspended = false,
  priority = 0,
  className = "",
  overlayClass = "",
  onSubmit,
  children,
}: {
  title: string;
  titleAside?: ReactNode;
  onClose: () => void;
  closeOnOverlay?: boolean;
  className?: string;
  overlayClass?: string;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  children: ReactNode;
} & Omit<DialogKeys, "onEscape"> & { onEscape?: () => void }) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  useDialogKeys(panel, { onEscape, initialFocus, suspended, priority });
  const titleNode = (
    <div id={titleId} className="dialog-title">
      {title}
    </div>
  );
  const content = (
    <>
      {titleAside ? (
        <div className="ui-dialog-heading">
          {titleNode}
          {titleAside}
        </div>
      ) : (
        titleNode
      )}
      {children}
    </>
  );
  const panelProps = {
    className: className ? `dialog ${className}` : "dialog",
    role: "dialog",
    "aria-labelledby": titleId,
    tabIndex: -1,
    ref: (element: HTMLElement | null) => {
      panel.current = element;
    },
  };
  return createPortal(
    <div
      className={overlayClass ? `dialog-overlay ${overlayClass}` : "dialog-overlay"}
      inert={suspended || undefined}
      aria-hidden={suspended || undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (top()?.frame === panel.current && closeOnOverlay && e.target === e.currentTarget)
          onClose();
      }}
    >
      {onSubmit ? (
        <form {...panelProps} onSubmit={onSubmit}>
          {content}
        </form>
      ) : (
        <div {...panelProps}>{content}</div>
      )}
    </div>,
    document.body,
  );
}
