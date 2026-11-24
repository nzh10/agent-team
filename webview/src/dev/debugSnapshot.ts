// One-tap layout snapshot for debugging rendering on devices we cannot
// attach a debugger to: viewport facts, geometry of the shell elements,
// active-turn layout diagnostics, the CSS variables that drive sizing, and
// the DOM itself (message bodies trimmed, tool payloads stripped). Posted
// to the server, which stores it as a JSON file.

import { readViewportFacts, ViewportFacts } from "../viewport/facts";

export interface RectBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface ElementGeometry {
  selector: string;
  rect: RectBox;
  display: string;
  position: string;
  height: string;
  paddingTop: string;
  paddingBottom: string;
  bottom: string;
  overflow: string;
  // Scrollers only: distinguishes "scrolled past the content" from "not
  // painted" when the transcript shows up empty.
  scroll?: { top: number; height: number; client: number };
}

export interface ChipGeometry {
  label: string;
  className: string;
  rect: RectBox;
  row: number;
  overflows: boolean;
}

export interface ActiveTurnDiagnostics {
  id: string | null;
  index: number;
  siblingCount: number;
  trailingSiblings: number;
  rect: RectBox;
  stepGroup?: {
    open: boolean;
    rect: RectBox;
    header?: ElementGeometry;
    liveChip?: ElementGeometry & { text: string };
    summary?: {
      text: string;
      rect: RectBox;
      lineCount: number;
      overflows: boolean;
    };
    toolsStrip?: ElementGeometry & {
      scrollWidth: number;
      clientWidth: number;
      scrollLeft: number;
      fadeStart: boolean;
      fadeEnd: boolean;
      moreText?: string;
    };
    toolChips: ChipGeometry[];
    toolChipsTotal: number;
    toolChipsTruncated: boolean;
    toolChipRowCount: number;
    liveThinking?: ElementGeometry;
  };
  turnFooter?: ElementGeometry & {
    state: "activity" | "thinking" | "waiting" | "quiet";
    text: string;
    liveChip?: ElementGeometry & { text: string };
    activity?: ElementGeometry & { text: string };
  };
}

export interface DebugSnapshot {
  takenAt: string;
  userAgent: string;
  url: string;
  viewport: ViewportFacts;
  window: { innerWidth: number; innerHeight: number; devicePixelRatio: number; scrollY: number };
  cssVars: Record<string, string>;
  elements: ElementGeometry[];
  activeTurn?: ActiveTurnDiagnostics;
  html: string;
}

export const SNAPSHOT_SELECTORS = [
  "html",
  "body",
  "#root",
  ".app",
  ".sidebar",
  ".main-panel",
  ".panel-header",
  ".messages",
  ".input-area",
  ".input-row",
  ".chat-input",
  ".empty-state",
  // First and last transcript entries: where the content actually sits.
  ".messages .message",
  ".messages > :last-child",
];

const MAX_ACTIVE_TURNS_IN_HTML = 2;
const MAX_TOOL_CHIPS = 12;
const MAX_HTML_EVENTS = 12;
const MAX_CHIP_LABEL_CHARS = 48;
const MAX_STATUS_TEXT_CHARS = 80;
const MAX_HTML_THINKING_CHARS = 160;
const ROW_TOP_TOLERANCE_PX = 2;

const round = (n: number) => Math.round(n * 10) / 10;

function rectBox(el: Element): RectBox {
  const r = el.getBoundingClientRect();
  return {
    top: round(r.top),
    bottom: round(r.bottom),
    left: round(r.left),
    right: round(r.right),
    width: round(r.width),
    height: round(r.height),
  };
}

function boundedText(el: Element | null | undefined, maxChars: number): string {
  const raw = (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  return raw.length > maxChars ? raw.slice(0, maxChars - 1) + "…" : raw;
}

function geometryOf(el: Element, selector: string): ElementGeometry {
  const cs = getComputedStyle(el);
  const scrolls = cs.overflowY === "auto" || cs.overflowY === "scroll";
  return {
    selector,
    ...(scrolls && {
      scroll: { top: round(el.scrollTop), height: el.scrollHeight, client: el.clientHeight },
    }),
    rect: rectBox(el),
    display: cs.display,
    position: cs.position,
    height: cs.height,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    bottom: cs.bottom,
    overflow: cs.overflow,
  };
}

function geometry(selector: string): ElementGeometry | null {
  const el = document.querySelector(selector);
  return el ? geometryOf(el, selector) : null;
}

function directChild(parent: Element, cls: string): Element | null {
  for (const child of parent.children) {
    if (child.classList.contains(cls)) return child;
  }
  return null;
}

function isActiveTurnElement(el: Element): boolean {
  if (!el.classList.contains("message") || el.classList.contains("message-user")) return false;
  const body = directChild(el, "message-body");
  if (body) {
    if (directChild(body, "turn-footer")) return true;
    const header = directChild(body, "message-header") ?? directChild(body, "compact-header");
    if (header && directChild(header, "streaming-dot")) return true;
  }
  return el.querySelector(".turn-footer") !== null;
}

function measureLineCount(el: Element): number {
  const text = (el.textContent ?? "").trim();
  if (!text) return 0;
  if (typeof document.createRange === "function") {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const lineTops: number[] = [];
      for (const rect of range.getClientRects()) {
        if (rect.width === 0 && rect.height === 0) continue;
        if (!lineTops.some((t) => Math.abs(t - rect.top) <= ROW_TOP_TOLERANCE_PX)) {
          lineTops.push(rect.top);
        }
      }
      if (lineTops.length > 0) return lineTops.length;
    } catch {
      // jsdom or detached nodes may not support Range.getClientRects.
    }
  }
  return 1;
}

function collectToolChips(chipElements: Element[]): {
  toolChips: ChipGeometry[];
  toolChipsTotal: number;
  toolChipsTruncated: boolean;
  toolChipRowCount: number;
} {
  const total = chipElements.length;
  const selected =
    total > MAX_TOOL_CHIPS ? chipElements.slice(total - MAX_TOOL_CHIPS) : chipElements;
  const rowTops: number[] = [];
  const toolChips: ChipGeometry[] = selected.map((chip) => {
    const rect = rectBox(chip);
    let row = rowTops.findIndex((t) => Math.abs(t - rect.top) <= ROW_TOP_TOLERANCE_PX);
    if (row < 0) {
      row = rowTops.length;
      rowTops.push(rect.top);
    }
    return {
      label: boundedText(chip, MAX_CHIP_LABEL_CHARS),
      className: chip.className,
      rect,
      row,
      overflows: chip.scrollWidth > chip.clientWidth,
    };
  });
  return {
    toolChips,
    toolChipsTotal: total,
    toolChipsTruncated: total > MAX_TOOL_CHIPS,
    toolChipRowCount: rowTops.length,
  };
}

export function collectActiveTurn(root: ParentNode = document): ActiveTurnDiagnostics | undefined {
  let match: { el: Element; index: number; siblingCount: number } | null = null;
  for (const list of root.querySelectorAll(".messages")) {
    const items = [...list.children].filter((c) => !c.classList.contains("history-hint"));
    for (let i = 0; i < items.length; i++) {
      if (isActiveTurnElement(items[i])) {
        match = { el: items[i], index: i, siblingCount: items.length };
      }
    }
  }
  if (!match) return undefined;

  const { el: activeTurn, index, siblingCount } = match;
  const diag: ActiveTurnDiagnostics = {
    id: activeTurn.getAttribute("id"),
    index,
    siblingCount,
    trailingSiblings: siblingCount - 1 - index,
    rect: rectBox(activeTurn),
  };

  const stepGroups = activeTurn.querySelectorAll(".step-group");
  const trailingStep = stepGroups.length > 0 ? stepGroups[stepGroups.length - 1] : null;
  if (trailingStep) {
    const open = trailingStep.classList.contains("open");
    const headerEl =
      directChild(trailingStep, "step-header") ?? trailingStep.querySelector(".step-header");
    const liveChipEl = headerEl?.querySelector(".chip-live");
    const summaryEl = headerEl?.querySelector(".step-summary") ?? null;
    const stripEl = headerEl?.querySelector(".step-tools") ?? null;
    const moreEl = stripEl?.querySelector(".step-tools-more") ?? null;
    const rawChips =
      !open && stripEl
        ? [...stripEl.querySelectorAll(".event-chip")]
        : open
          ? [
              ...trailingStep.querySelectorAll(
                ".events-list .event-tool_use .event-row .event-chip",
              ),
            ]
          : [];
    const liveThinkingEl = trailingStep.querySelector(".live-thinking");

    diag.stepGroup = {
      open,
      rect: rectBox(trailingStep),
      ...(headerEl && { header: geometryOf(headerEl, ".step-header") }),
      ...(liveChipEl && {
        liveChip: {
          ...geometryOf(liveChipEl, ".step-header .chip-live"),
          text: boundedText(liveChipEl, MAX_STATUS_TEXT_CHARS),
        },
      }),
      ...(summaryEl && {
        summary: {
          text: boundedText(summaryEl, MAX_STATUS_TEXT_CHARS),
          rect: rectBox(summaryEl),
          lineCount: measureLineCount(summaryEl),
          overflows: summaryEl.scrollWidth > summaryEl.clientWidth,
        },
      }),
      ...(stripEl && {
        toolsStrip: {
          ...geometryOf(stripEl, ".step-tools"),
          scrollWidth: stripEl.scrollWidth,
          clientWidth: stripEl.clientWidth,
          scrollLeft: round(stripEl.scrollLeft),
          fadeStart: stripEl.hasAttribute("data-fade-start"),
          fadeEnd: stripEl.hasAttribute("data-fade-end"),
          ...(moreEl && { moreText: boundedText(moreEl, 16) }),
        },
      }),
      ...collectToolChips(rawChips),
      ...(liveThinkingEl && { liveThinking: geometryOf(liveThinkingEl, ".live-thinking") }),
    };
  }

  const body = directChild(activeTurn, "message-body");
  const footerEl =
    (body ? directChild(body, "turn-footer") : null) ?? activeTurn.querySelector(".turn-footer");
  if (footerEl) {
    const activityEl = footerEl.querySelector(".turn-activity");
    const liveChipEl = footerEl.querySelector(".chip-live");
    const text = boundedText(footerEl, MAX_STATUS_TEXT_CHARS);
    const state: NonNullable<ActiveTurnDiagnostics["turnFooter"]>["state"] = activityEl
      ? "activity"
      : liveChipEl
        ? "thinking"
        : text
          ? "waiting"
          : "quiet";
    diag.turnFooter = {
      ...geometryOf(footerEl, ".turn-footer"),
      state,
      text,
      ...(liveChipEl && {
        liveChip: {
          ...geometryOf(liveChipEl, ".turn-footer .chip-live"),
          text: boundedText(liveChipEl, MAX_STATUS_TEXT_CHARS),
        },
      }),
      ...(activityEl && {
        activity: {
          ...geometryOf(activityEl, ".turn-footer .turn-activity"),
          text: boundedText(activityEl, MAX_STATUS_TEXT_CHARS),
        },
      }),
    };
  }

  return diag;
}

const TOOL_PAYLOAD_SELECTOR = [
  ".event-tool_use .event-content",
  ".event-tool_use .event-summary-line",
  ".event-tool_use .event-result",
  ".event-tool_result .event-content",
  ".event-tool_result .event-result",
  ".banner-action .banner-text > :not(.banner-label):not(.action-target)",
  ".subagent-prompt",
  ".subagent-summary",
  ".subagent-events .event-text .event-content",
].join(", ");

// The DOM with message bodies cut down: layout matters, transcripts and tool
// payloads don't. Explicitly retains the active turn even when newer queued or
// system items follow it.
export function trimmedHtml(maxMessages = 3): string {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  for (const list of clone.querySelectorAll(".messages")) {
    const items = [...list.children].filter((c) => !c.classList.contains("history-hint"));
    const keep = new Set<Element>(items.slice(Math.max(0, items.length - maxMessages)));
    const activeItems = items.filter(isActiveTurnElement);
    for (const active of activeItems.slice(
      Math.max(0, activeItems.length - MAX_ACTIVE_TURNS_IN_HTML),
    )) {
      keep.add(active);
    }
    for (const item of items) {
      if (!keep.has(item)) item.remove();
    }
  }
  for (const list of clone.querySelectorAll(".events-list, .subagent-events")) {
    const events = [...list.children];
    if (events.length > MAX_HTML_EVENTS) {
      const keep = new Set<Element>(events.slice(events.length - MAX_HTML_EVENTS));
      for (const ev of events) {
        if (ev.classList.contains("live-thinking")) keep.add(ev);
      }
      for (const ev of events) {
        if (!keep.has(ev)) ev.remove();
      }
    }
  }
  for (const payload of clone.querySelectorAll(TOOL_PAYLOAD_SELECTOR)) {
    payload.replaceChildren();
    payload.setAttribute("data-trimmed", "payload");
  }
  for (const thinking of clone.querySelectorAll(
    ".event-thinking .event-content, .live-thinking .event-content",
  )) {
    const text = (thinking.textContent ?? "").trim();
    if (text.length > MAX_HTML_THINKING_CHARS) {
      thinking.textContent = text.slice(0, MAX_HTML_THINKING_CHARS - 1) + "…";
    }
  }
  for (const s of clone.querySelectorAll("script")) s.remove();
  return "<!doctype html>\n" + clone.outerHTML;
}

export function collectSnapshot(): DebugSnapshot {
  const rootStyle = document.documentElement.style;
  const cssVars: Record<string, string> = {};
  for (const name of ["--app-height", "--app-offset"]) {
    cssVars[name] = rootStyle.getPropertyValue(name) || "(unset)";
  }
  const activeTurn = collectActiveTurn();
  return {
    takenAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    url: window.location.href,
    viewport: readViewportFacts(),
    window: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollY: window.scrollY,
    },
    cssVars,
    elements: SNAPSHOT_SELECTORS.map(geometry).filter((g): g is ElementGeometry => !!g),
    ...(activeTurn && { activeTurn }),
    html: trimmedHtml(),
  };
}

export async function uploadSnapshot(): Promise<string> {
  const snap = collectSnapshot();
  const res = await fetch("debug/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(snap),
  });
  if (!res.ok) throw new Error(`snapshot upload failed: ${res.status}`);
  const data = (await res.json()) as { path: string };
  return data.path;
}
