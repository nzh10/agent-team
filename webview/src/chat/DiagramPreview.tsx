import {
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "../panels/Icon";
import { telemetryTarget } from "../telemetryEvents";
import { DiagramCache, DiagramCacheContext, type DiagramAnswer } from "./diagramCache";
import { useTranscriptChoice, useTranscriptChoiceOwner } from "./transcriptChoices";
import "./DiagramPreview.css";

export type DiagramLanguage = "mermaid" | "graphviz";
export type DiagramTheme = "light" | "dark";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : "";
}

export function diagramSource(children: ReactNode): string {
  return textOf(children).replace(/\r?\n$/, "");
}

export function diagramLanguage(children: ReactNode): DiagramLanguage | null {
  if (!isValidElement<{ className?: string }>(children)) return null;
  const classes = children.props.className?.split(/\s+/) ?? [];
  const language = classes
    .find((name) => name.toLowerCase().startsWith("language-"))
    ?.slice(9)
    .toLowerCase();
  if (language === "mermaid") return "mermaid";
  if (language === "graphviz" || language === "dot") return "graphviz";
  return null;
}

function currentTheme(): DiagramTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function useDiagramPreview(
  language: DiagramLanguage,
  source: string,
  slot: string,
  offset?: number,
) {
  const owner = useTranscriptChoiceOwner();
  const instance = useId();
  const shared = useContext(DiagramCacheContext);
  const [local] = useState(() => new DiagramCache());
  const cache = shared ?? local;
  const choice = JSON.stringify([slot, offset ?? instance, language]);
  const [remembered, remember] = useTranscriptChoice<boolean>(`diagram:${choice}`, false);
  const [requested, setRequested] = useState<string | null>(() => (remembered ? source : null));
  const [theme, setTheme] = useState(currentTheme);
  const [answer, setAnswer] = useState<{ key: string; value: DiagramAnswer }>();
  const prior = useRef<{ source: string; theme: DiagramTheme; svg: string } | null>(null);
  const requestKey = useRef<string | null>(null);
  const open = requested === source;
  const key = useMemo(
    () => (open ? JSON.stringify([owner ?? instance, choice, theme, source]) : ""),
    [choice, instance, open, owner, source, theme],
  );
  const hit = open ? cache.peek(key) : undefined;
  const current = open && answer?.key === key ? answer.value : undefined;
  const error = current && "error" in current ? current.error : undefined;
  // Keep the prior graphic while replacing its theme, but never show the
  // previous source. Use the same render-time result for SVG and <pre hidden>.
  const svg = hit ?? (current && "svg" in current ? current.svg : undefined);
  const display =
    open && !error
      ? svg
        ? { source, theme, svg }
        : prior.current?.source === source
          ? prior.current
          : null
      : null;
  const box = open && !display && !error ? cache.box(key) : undefined;

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => () => local.clear(), [local]);
  useLayoutEffect(() => {
    prior.current = display;
    if (open && (hit || box)) cache.touch(key);
  });
  useLayoutEffect(() => {
    if (requestKey.current && (!open || requestKey.current !== key))
      cache.abandon(requestKey.current);
    requestKey.current = open ? key : null;
    if (open && !hit && !current)
      return cache.request(key, { source, language, theme }, (value) => setAnswer({ key, value }));
  }, [cache, current, hit, key, language, open, source, theme]);
  useLayoutEffect(() => {
    if (requested !== null && !open) {
      remember(false);
      setRequested(null);
      setAnswer(undefined);
    }
  }, [open, remember, requested]);

  const toggle = () => {
    remember(!open);
    if (open) {
      cache.abandon(key);
      setAnswer(undefined);
    }
    setRequested(open ? null : source);
  };
  return { open, toggle, display, box, error, language };
}

export function DiagramPreview({
  open,
  toggle,
  display,
  box,
  error,
  language,
  copy,
}: ReturnType<typeof useDiagramPreview> & { copy: ReactNode }) {
  const label = open ? "Show code" : "Preview diagram";
  const loading = open && !display && !error;
  return (
    <>
      <div className="code-block-actions">
        {copy}
        <button
          type="button"
          className="copy-btn diagram-toggle"
          aria-label={label}
          aria-pressed={open}
          title={label}
          {...telemetryTarget(open ? undefined : "chat.diagram_preview")}
          onClick={toggle}
        >
          <Icon name={open ? "code" : "diagram"} />
        </button>
      </div>
      {/* Keep the live region mounted so assistive technology can announce its update. */}
      <span className="diagram-preview-status" role="status">
        {loading ? "Rendering diagram…" : null}
      </span>
      {box && (
        <div
          className="diagram-preview diagram-reservation"
          style={
            {
              "--diagram-width": `${box.width}px`,
              "--diagram-height": `${box.height}px`,
            } as CSSProperties
          }
        />
      )}
      {error && (
        <p className="diagram-preview-error" role="alert">
          Diagram preview failed: {error}
        </p>
      )}
      {display && (
        <div
          className={`diagram-preview diagram-preview--${language}`}
          data-theme={display.theme}
          aria-label="Diagram preview"
          dangerouslySetInnerHTML={{ __html: display.svg }}
        />
      )}
    </>
  );
}
