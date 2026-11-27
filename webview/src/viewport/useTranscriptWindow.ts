import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { Message } from "../state/useServer";
import { rememberReadingPosition, type ReadingPosition } from "./readingAnchor";
import {
  rowAt,
  transcriptGeometry,
  transcriptRange,
  WINDOW_OVERSCAN,
  WINDOW_ROWS,
} from "./transcriptWindow";

const EMPTY_MESSAGES: Message[] = [];

type Request = { workspaceId: string; id?: string; held?: string[] };
export interface WindowRestore {
  workspaceId: string;
  position: ReadingPosition;
  backfill: boolean;
}

function heldRows(el: HTMLElement): string[] {
  const row = (node: Node | null | undefined) => {
    const element = node instanceof Element ? node : node?.parentElement;
    const result = element?.closest<HTMLElement>("[data-transcript-row]");
    return result && el.contains(result) ? result.dataset.transcriptRow : undefined;
  };
  const selection = window.getSelection();
  return [
    ...new Set(
      [
        row(document.activeElement),
        ...(!selection?.isCollapsed ? [row(selection?.anchorNode), row(selection?.focusNode)] : []),
      ].filter((id): id is string => !!id),
    ),
  ];
}

function tabStops(row: HTMLElement): HTMLElement[] {
  return [
    ...row.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
    ),
  ].filter((el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0);
}

export function useTranscriptWindow({
  workspaceId,
  messages: supplied,
  getReadingPosition,
  prependAnchor,
  jumpId,
  scroller,
}: {
  workspaceId: string | undefined;
  messages: Message[] | undefined;
  getReadingPosition: (workspaceId: string) => ReadingPosition | undefined;
  prependAnchor: string | undefined;
  jumpId: string | undefined;
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const messages = supplied ?? EMPTY_MESSAGES;
  const saved = workspaceId ? getReadingPosition(workspaceId) : undefined;
  const measured = useRef(new WeakMap<Message, { width: number; height: number }>());
  const [box, setBox] = useState({ width: 800, height: 720 });
  const observedBox = useRef(box);
  const [request, setRequest] = useState<Request | null>(null);
  if (request && request.workspaceId !== workspaceId) setRequest(null);
  const pendingRestore = useRef<WindowRestore | null>(null);
  const keyboard = useRef<{ workspaceId: string; id: string; backwards: boolean } | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const geometry = useMemo(
    () => transcriptGeometry(messages, box.width, measured.current),
    // A new window uses measurements since the last render, without forcing
    // a React commit for each ResizeObserver notification during a stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, box.width, request],
  );
  const current = request?.workspaceId === workspaceId ? request : null;
  const id =
    current && (current.id === undefined || geometry.indexById.has(current.id))
      ? current.id
      : saved?.following === false
        ? saved.id
        : undefined;
  const range = transcriptRange(
    geometry.offsets,
    box.height,
    geometry.indexById.get(jumpId ?? "") ??
      geometry.indexById.get(prependAnchor ?? "") ??
      geometry.indexById.get(id ?? ""),
  );
  const held = current?.held;
  const indices = useMemo(() => {
    const result = new Set<number>();
    for (let i = range.start; i < range.end; i++) result.add(i);
    for (const id of held ?? []) {
      const index = geometry.indexById.get(id);
      if (index !== undefined) result.add(index);
    }
    return [...result].sort((a, b) => a - b);
  }, [geometry.indexById, held, range.start, range.end]);
  const byId = useRef(new Map<string, Message>());
  useLayoutEffect(() => {
    const next = new Map<string, Message>();
    for (const index of indices) next.set(geometry.ids[index], messages[index]);
    byId.current = next;
  }, [geometry.ids, indices, messages]);

  const moveTo = useCallback(
    (el: HTMLElement, id: string | undefined, position: ReadingPosition, backfill: boolean) => {
      if (!workspaceId) return;
      pendingRestore.current = { workspaceId, position, backfill };
      setRequest({ workspaceId, id, held: heldRows(el) });
    },
    [workspaceId],
  );

  useLayoutEffect(() => {
    const list = content.current;
    const host = scroller.current;
    if (!list || !host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = list.clientWidth;
      const height = host.clientHeight;
      const previous = observedBox.current;
      if (width > 0 && height > 0 && (previous.width !== width || previous.height !== height)) {
        observedBox.current = { width, height };
        if (previous.width !== width && workspaceId && messages.length > WINDOW_ROWS) {
          // Row reflow and spacer re-estimation are separate layout changes.
          // Carry the latest scroll anchor (which need not have caused a render)
          // into the window and spacer commit at the new width.
          const position = getReadingPosition(workspaceId) ?? { following: true };
          moveTo(host, position.following ? undefined : position.id, position, false);
        }
        setBox({ width, height });
      }
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement) || !list.contains(entry.target)) continue;
        const msg = byId.current.get(entry.target.dataset.transcriptRow ?? "");
        const rowHeight = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (msg && width > 0 && rowHeight > 0)
          measured.current.set(msg, { width, height: rowHeight });
      }
    });
    observer.observe(host);
    for (const row of list.querySelectorAll("[data-transcript-row]")) observer.observe(row);
    return () => observer.disconnect();
  }, [workspaceId, scroller, indices, messages.length, getReadingPosition, moveTo]);

  function track(el: HTMLElement, following: boolean): boolean {
    const { start, end } = range;
    if (start === end || (start === 0 && end === messages.length)) return false;
    const first = content.current?.querySelector<HTMLElement>("[data-window-first]");
    const last = content.current?.querySelector<HTMLElement>("[data-window-last]");
    if (!first || !last) return false;
    const view = el.getBoundingClientRect();
    const firstTop = first.getBoundingClientRect().top;
    const lastBottom = last.getBoundingClientRect().bottom;
    const nearStart = start > 0 && view.top < firstTop + WINDOW_OVERSCAN / 2;
    const nearEnd = end < messages.length && view.bottom > lastBottom - WINDOW_OVERSCAN / 2;
    if (!nearStart && !nearEnd) return false;
    if (following) {
      moveTo(el, undefined, { following: true }, false);
      return true;
    }
    let position = rememberReadingPosition(el, false);
    // A scrollbar drag or a large wheel delta can land inside a spacer.
    // Turn the virtual offset back into an actual row anchor on the commit.
    if ((view.top < firstTop && start > 0) || (view.top >= lastBottom && end < messages.length)) {
      const virtualTop =
        view.top < firstTop
          ? geometry.offsets[start] + view.top - firstTop
          : geometry.offsets[end] + view.top - lastBottom;
      const index = rowAt(geometry.offsets, virtualTop);
      position = {
        following: false,
        id: geometry.ids[index],
        offset: geometry.offsets[index] - virtualTop,
        top: el.scrollTop,
      };
    }
    if (position.following || !position.id) return false;
    const anchor = geometry.indexById.get(position.id);
    if (anchor === undefined) return false;
    const next = transcriptRange(geometry.offsets, box.height, anchor);
    if (start === next.start && end === next.end) return false;
    moveTo(el, position.id, position, true);
    return true;
  }

  function tabAcrossWindow(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.key !== "Tab" ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !workspaceId
    )
      return;
    const el = scroller.current;
    const focus = document.activeElement;
    if (!el || !focus || !el.contains(focus)) return;
    const row = focus.closest<HTMLElement>("[data-transcript-row]");
    const index = geometry.indexById.get(row?.dataset.transcriptRow ?? "");
    if (!row || index === undefined) return;
    const backwards = event.shiftKey;
    const direction = backwards
      ? Node.DOCUMENT_POSITION_PRECEDING
      : Node.DOCUMENT_POSITION_FOLLOWING;
    if (tabStops(row).some((stop) => Boolean(focus.compareDocumentPosition(stop) & direction)))
      return;
    const step = backwards ? -1 : 1;
    const mounted = new Set(indices);
    for (let i = index + step; i >= 0 && i < messages.length; i += step) {
      const id = geometry.ids[i];
      if (!mounted.has(i)) {
        // Native Tab handles visible controls. At a spacer, mount the next
        // rows before transferring focus so a keyboard reader doesn't skip
        // straight from a partially mounted transcript into the composer.
        event.preventDefault();
        keyboard.current = { workspaceId, id, backwards };
        setRequest({ workspaceId, id, held: heldRows(el) });
        return;
      }
      const target = document.getElementById(id)?.closest<HTMLElement>("[data-transcript-row]");
      if (target && tabStops(target).length > 0) return;
    }
  }

  useLayoutEffect(() => {
    const move = keyboard.current;
    if (!move || move.workspaceId !== workspaceId) return;
    keyboard.current = null;
    const start = geometry.indexById.get(move.id);
    if (start === undefined) return;
    const step = move.backwards ? -1 : 1;
    for (let i = start; i >= range.start && i < range.end; i += step) {
      const row = document
        .getElementById(geometry.ids[i])
        ?.closest<HTMLElement>("[data-transcript-row]");
      const focus = row && tabStops(row).at(move.backwards ? -1 : 0);
      if (focus) {
        focus.focus();
        return;
      }
    }
    // A run of system/text-only rows still has a reading location, from
    // which the next Tab can enter the next mounted controls.
    document.getElementById(move.id)?.focus();
  }, [geometry, range.start, range.end, workspaceId]);

  const preserve = useCallback(
    (el: HTMLElement, position: ReadingPosition) => {
      if (!position.following && position.id) moveTo(el, position.id, position, false);
    },
    [moveTo],
  );

  const setTarget = useCallback(
    (el: HTMLElement, id: string | undefined) => {
      if (id === undefined) moveTo(el, undefined, { following: true }, false);
      else if (workspaceId) {
        // A quote can arrive in the same prepend that queued restoration of
        // the old reading anchor. The requested destination takes precedence.
        pendingRestore.current = null;
        setRequest({ workspaceId, id, held: heldRows(el) });
      }
    },
    [moveTo, workspaceId],
  );

  return {
    content,
    geometry,
    indices,
    range,
    pendingRestore,
    preserve,
    track,
    setTarget,
    tabAcrossWindow,
  };
}
