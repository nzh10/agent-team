export type ChatRedundancyFinding = {
  rule: "result-label" | "live-thinking" | "tool-summary" | "subagent-duration";
  messageId?: string;
  selector: string;
  index: number;
};

const TOOL_SUMMARY_FINDING = "data-audit-duplicate-tool-summary";
const text = (node: Element | null | undefined) => node?.textContent?.trim() ?? "";

/** Preserve the finding, not the tool payload, on a cloned snapshot DOM. */
export function markToolSummaryDuplicates(clone: ParentNode): void {
  for (const row of clone.querySelectorAll(".event-tool_use")) {
    if (hasDuplicateToolSummary(row)) row.setAttribute(TOOL_SUMMARY_FINDING, "");
  }
}

/** Audit rendered chat structure. Pass a DOM root or `debugSnapshot.html`.
 * Collapsed bodies are not inspected; expand traces before capturing to audit them.
 */
export function auditChatRedundancy(input: ParentNode | string): ChatRedundancyFinding[] {
  const root =
    typeof input === "string" ? new DOMParser().parseFromString(input, "text/html") : input;
  const findings: ChatRedundancyFinding[] = [];
  function audit(
    rule: ChatRedundancyFinding["rule"],
    selector: string,
    violates: (element: Element) => boolean,
  ) {
    const elements = [...root.querySelectorAll(selector)];
    if ((root as Element).matches?.(selector)) elements.unshift(root as Element);
    elements.forEach((element, index) => {
      if (violates(element)) {
        findings.push({ rule, selector, index, messageId: element.closest(".message[id]")?.id });
      }
    });
  }

  audit("result-label", ".event-tool_result", (row) => {
    const chips = row.querySelectorAll(":scope > .event-row > .event-chip");
    const toggles = row.querySelectorAll(":scope > .event-row > .btn-diff");
    const action =
      row.querySelector(":scope > .event-result") ||
      toggles[0]?.getAttribute("aria-expanded") === "true"
        ? "Hide"
        : "Show";
    return (
      chips.length !== 1 ||
      text(chips[0]) !== "Result" ||
      toggles.length !== 1 ||
      !new RegExp(`^${action} · \\d+k? chars$`).test(text(toggles[0]))
    );
  });

  audit("live-thinking", ".message-agent", (message) => {
    const header = ":scope > .message-body > .message-content > div > .step-group > .step-header";
    const headerChips = message.querySelectorAll(`${header} > .chip-live`);
    const footer = message.querySelector(":scope > .message-body > .turn-footer");
    if (headerChips.length > 1 || (headerChips.length === 1 && text(footer))) return true;
    // An expanded live body is not a second status row. Historical thoughts use
    // .event-thinking without .live-thinking and can coexist with the status.
    return !!message.querySelector(".event-thinking.live-thinking > .event-row > .chip-thinking");
  });

  audit(
    "tool-summary",
    ".event-tool_use",
    (row) => row.hasAttribute(TOOL_SUMMARY_FINDING) || hasDuplicateToolSummary(row),
  );

  audit("subagent-duration", ".subagent-item", (card) => {
    const times = card.querySelectorAll(":scope > .subagent-header > .subagent-time");
    const usage = card.querySelector(":scope > .subagent-body > .subagent-usage");
    // Usage is a token/tool count, not a second elapsed time for this run.
    return (
      times.length > 1 ||
      (times.length === 1 && !!usage && !/^\d+k tokens · \d+ tools$/.test(text(usage)))
    );
  });
  return findings;
}

function hasDuplicateToolSummary(row: Element): boolean {
  const summary = text(row.querySelector(":scope > .event-summary-line > code"));
  const label = text(row.querySelector(":scope > .event-row > .event-chip"));
  const first = row.querySelector(
    ":scope > .event-content:not(.event-result):not(.event-placeholder)",
  )?.firstElementChild;
  if (first?.tagName !== "P") return false;
  const firstLine = text(first).split("\n", 1)[0];
  if (summary) {
    return (
      firstLine === summary ||
      (text(first.firstElementChild) === label && firstLine === `${label} ${summary}`)
    );
  }
  // A redundant bold tool heading directly above a fenced body (or alone),
  // not an arbitrary mention of the tool in the output.
  return (
    !!label &&
    first.firstElementChild?.tagName === "STRONG" &&
    text(first).toLowerCase() === label.toLowerCase() &&
    (!first.nextElementSibling || first.nextElementSibling.matches(".code-block, pre"))
  );
}
