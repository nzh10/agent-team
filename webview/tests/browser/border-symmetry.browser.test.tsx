import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { BannerItem, EventItem, MessageStatus } from "../../src/chat/messages";
import { MdBlock } from "../../src/chat/markdown";
import { AgentsPanel } from "../../src/panels/AgentsPanel";
import type { ComponentProps } from "react";
import { SessionStats } from "../../src/panels/SessionStats";
import { QuotaPanel } from "../../src/sidebar/QuotaPanel";
import { SystemStatusPanel } from "../../src/sidebar/Sidebar";
import { agentsActions } from "../helpers/agentsPanel";
import {
  agent as makeAgent,
  objective,
  project as makeProject,
  workspace as makeWorkspace,
} from "../helpers/fixtures";
import "../../src/styles.css";

const NOW = Date.UTC(2026, 10, 25, 12);
const no = () => {};
const agent = makeAgent("agent", {
  model: "model",
  color: "#528bff",
  context: { tokens: 1200, window: 8192 },
});
const workspace = makeWorkspace("worker", {
  project: "Project",
  cwd: "/repo/worker",
  agents: [agent],
  createdAt: NOW - 1000,
  lastMessageAt: NOW,
  projectLink: { projectId: "project", role: "worker" },
  git: { branch: "feature/symmetry", dirty: 1, ahead: 0, behind: 0 },
});
const project = makeProject("project", {
  createdAt: NOW - 2000,
  objectives: [
    objective("obj-1", {
      area: "UI",
      title: "Balanced cards",
      goal: "Keep content evenly inset",
      context: "",
      tasks: [{ id: "task-1", text: "Audit every border", state: "doing", session: "worker" }],
      sessions: ["worker"],
      notes: "",
      updatedAt: NOW,
    }),
  ],
});
const actions = agentsActions({}, () => no);
const busySession = () => ({ ...workspace, agents: [{ ...agent, busy: true }] });
const panel = (fields: Partial<ComponentProps<typeof AgentsPanel>> = {}) => (
  <AgentsPanel
    sessions={[workspace]}
    project={project}
    activeWsId={workspace.id}
    connected
    models={[]}
    actions={actions}
    {...fields}
  />
);

// Atomic controls and selected flow sections contribute their border box; other
// text contributes a layout Range. This guard is not an audit of painted spacing.
function contentInsets(element: HTMLElement, flowSections?: string) {
  const bounds = element.getBoundingClientRect();
  const computed = getComputedStyle(element);
  const topBorder = bounds.top + element.clientTop;
  const bottomBorder = bounds.bottom - parseFloat(computed.borderBottomWidth);
  const content: DOMRect[] = [];
  const atomic = /^(BUTTON|INPUT|SELECT|TEXTAREA|SVG|IMG|VIDEO|CANVAS)$/;

  function visit(node: Node) {
    const owner =
      node.nodeType === Node.TEXT_NODE ? node.parentElement : node instanceof Element ? node : null;
    for (
      let closed = owner?.closest("details:not([open])");
      closed;
      closed = closed.parentElement?.closest("details:not([open])")
    ) {
      const summary = [...closed.children].find((child) => child.tagName === "SUMMARY");
      if (closed !== owner && !summary?.contains(owner)) return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.textContent?.trim()) return;
      const range = document.createRange();
      range.selectNode(node);
      const rect = range.getBoundingClientRect();
      if (range.getClientRects().length && (rect.width > 0 || rect.height > 0)) content.push(rect);
      return;
    }
    if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return;
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      (style.display !== "contents" && node.getClientRects().length === 0) ||
      node.classList.contains("copy-btn")
    )
      return;
    const inlineBorder =
      parseFloat(style.borderLeftWidth) > 0 || parseFloat(style.borderRightWidth) > 0;
    const blockBorders =
      parseFloat(style.borderTopWidth) > 0 && parseFloat(style.borderBottomWidth) > 0;
    // Controls, nested disclosure summaries and nested boxes already include
    // their own content padding. Count it once, at the outermost audited
    // border. Closed <details> content is excluded above.
    if (
      node !== element &&
      (atomic.test(node.tagName) ||
        (flowSections && node.matches(flowSections)) ||
        /^H[1-4]$/.test(node.tagName) ||
        (node.tagName === "SUMMARY" && node.parentElement !== element) ||
        ((inlineBorder || blockBorders) && node.parentElement !== element) ||
        node.childNodes.length === 0)
    ) {
      content.push(node.getBoundingClientRect());
      return;
    }
    node.childNodes.forEach(visit);
  }
  element.childNodes.forEach(visit);
  if (content.length === 0) throw new Error(`No measurable content in ${element.outerHTML}`);
  const top = Math.min(...content.map((rect) => rect.top));
  const bottom = Math.max(...content.map((rect) => rect.bottom));
  return { top: top - topBorder, bottom: bottomBorder - bottom };
}

const selectors = {
  "banner-notice": "#audit-banner-notice > .banner",
  "banner-list": "#audit-banner-list > .banner",
  "banner-list-only": "#audit-banner-list-only > .banner",
  "banner-heading-only": "#audit-banner-heading-only > .banner",
  "banner-quote-only": "#audit-banner-quote-only > .banner",
  "banner-code-only": "#audit-banner-code-only > .banner",
  "banner-schedule": "#audit-banner-schedule > .banner",
  "banner-compact": "#audit-banner-compact > .banner",
  "archived-banner": "#audit-archived-banner > .archived-banner",
  "sealed-banner": "#audit-sealed-banner > .sealed-banner",
  "status-chip": "#audit-status-chip .status-chip",
  "event-chip": "#audit-event-chip .event-chip",
  "event-summary": "#audit-event-chip .event-summary-line",
  "message-pre": "#audit-message-pre pre",
  "message-blockquote": "#audit-message-blockquote blockquote",
  "message-table": "#audit-message-table td",
  "pr-card": "#audit-pr-card > .pr-card",
  "agents-chip": "#audit-agents-chip > .agents-chip",
  "quote-bar": "#audit-quote-bar > .quote-bar",
  "input-row": "#audit-input-row > .input-row",
  "system-status": "#audit-system-status > .system-status-panel",
  "quota-panel": "#audit-quota-panel > .quota-panel",
  "quota-empty": "#audit-quota-empty > .quota-panel",
  "quota-details": "#audit-quota-panel .quota-details",
  "ap-collapsed": "#audit-ap-collapsed .ap-session",
  "ap-collapsed-busy": "#audit-ap-collapsed-busy .ap-session",
  "ap-expanded-footer-targets": "#audit-ap-expanded .ap-session-foot",
  "ap-sealed-footer-label": "#audit-ap-expanded-readonly .ap-session-foot",
  "bp-card": "#audit-bp-card > .bp-card",
  "bp-node": "#audit-bp-node > .bp-node",
  "bi-row": "#audit-bi-row > .bi-row",
  "usage-card": "#audit-usage-card > .usage-card",
  "stats-collapsed": "#audit-stats .session-stats-turn:nth-of-type(1)",
  "stats-no-steps": "#audit-stats .session-stats-turn:nth-of-type(2)",
  "stats-expanded-row": "#audit-stats .session-stats-turn:nth-of-type(3) li",
  "stats-open-row": "#audit-stats .session-stats-turn:nth-of-type(4) li",
  dialog: "#audit-dialog > .dialog",
  "command-popup": "#audit-command-popup > .command-popup",
  "ui-option": "#audit-ui-option > .ui-dialog-option",
  "ui-alert": "#audit-ui-alert > .ui-dialog-alert",
};

// These edge sections use line layout, not the font's ascent/descent rectangle.
// Measuring the descendants (not the card's content box) still catches shifts
// caused by margins and alignment, as well as uneven card padding.
const flowSections: Partial<Record<keyof typeof selectors, string>> = {
  "banner-notice": ".banner-icon, .banner-text > p",
  "banner-compact": ".banner-icon, .banner-text",
  "bp-card": ".bp-id, .bp-card-title, .bp-card-goal, .bp-stage",
  "bi-row": ".bi-evidence, .bp-id, .bi-row-text",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { layout: "desktop", width: 1280, height: 900 },
  { layout: "mobile", width: 390, height: 844 },
])("audits control, flow-section and text-range insets on $layout", async ({ width, height }) => {
  await page.viewport(width, height);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          turns: [
            { turnId: "collapsed", trigger: "manual", steps: [{ stepId: "s1", kind: "user" }] },
            { turnId: "no-steps", trigger: "manual", steps: [] },
            { turnId: "closed-step", trigger: "manual", steps: [{ stepId: "s2", kind: "user" }] },
            { turnId: "open-step", trigger: "manual", steps: [{ stepId: "s3", kind: "user" }] },
          ],
          total: 4,
          offset: 0,
          limit: 20,
        }),
      ),
    ),
  );
  render(
    <div style={{ width: "min(720px, 100vw)", padding: 20 }}>
      <div className="message-content">
        <div id="audit-banner-notice">
          <BannerItem ev={{ kind: "notice", content: "A plain notice" }} />
        </div>
        <div id="audit-banner-list">
          <BannerItem
            ev={{
              kind: "notice",
              level: "schedule",
              content: "Scheduled prompt\n\n- one\n- two",
            }}
          />
        </div>
        <div id="audit-banner-list-only">
          <BannerItem ev={{ kind: "notice", content: "- one\n- two" }} />
        </div>
        <div id="audit-banner-heading-only">
          <BannerItem ev={{ kind: "notice", content: "### Heading" }} />
        </div>
        <div id="audit-banner-quote-only">
          <BannerItem ev={{ kind: "notice", content: "> quoted task" }} />
        </div>
        <div id="audit-banner-code-only">
          <BannerItem ev={{ kind: "notice", content: "```ts\nconst answer = 42;\n```" }} />
        </div>
        <div id="audit-banner-schedule">
          <BannerItem
            ev={{
              kind: "notice",
              level: "schedule",
              content: "Scheduled prompt\n\n> quoted task",
            }}
          />
        </div>
        <div id="audit-banner-compact">
          <BannerItem ev={{ kind: "compact", content: "Compacted context" }} />
        </div>
      </div>
      <div id="audit-archived-banner">
        <div className="archived-banner">
          <span>Archived session</span>
          <button className="btn-inline">Restore</button>
        </div>
      </div>
      <div id="audit-sealed-banner">
        <div className="sealed-banner">Sealed project</div>
      </div>
      <div id="audit-status-chip">
        <MessageStatus msg={{ effort: "high" }} />
      </div>
      <div id="audit-event-chip">
        <EventItem
          ev={{
            kind: "tool_use",
            content: "**Bash** `pwd`",
            toolName: "Bash",
            toolInput: { tool: "Bash" },
          }}
        />
      </div>
      <div id="audit-message-pre" className="message-content">
        <MdBlock>{"```ts\nconst answer = 42;\n```"}</MdBlock>
      </div>
      <div id="audit-message-blockquote" className="message-content">
        <MdBlock>{"> quoted text"}</MdBlock>
      </div>
      <div id="audit-message-table" className="message-content">
        <MdBlock>{"| A | B |\n| - | - |\n| 1 | 2 |"}</MdBlock>
      </div>
      <div id="audit-pr-card">
        <a className="pr-card pr-open">
          <span className="pr-number">#42</span>
          <span className="pr-title">Balanced borders</span>
          <span className="pr-state">open</span>
        </a>
      </div>
      <div id="audit-agents-chip">
        <button className="agents-chip">
          <span className="agents-chip-label">1 agent</span>
        </button>
      </div>
      <div id="audit-quote-bar">
        <div className="quote-bar">
          <button className="quote-bar-content">
            <span className="quote-bar-agent">Agent</span>
            <span className="quote-bar-preview">Quoted message</span>
          </button>
          <button className="quote-bar-close">×</button>
        </div>
      </div>
      <div id="audit-input-row">
        <div className="input-row">
          <textarea className="chat-input" defaultValue="Message" />
          <button>Send</button>
        </div>
      </div>
      <div id="audit-system-status">
        <SystemStatusPanel
          status={{
            osName: "Linux",
            osArch: "x64",
            cpuModel: "CPU",
            cpuCores: 8,
            hostname: "host",
            cpuUsage: 20,
            memUsed: 4 * 1024 ** 3,
            memTotal: 16 * 1024 ** 3,
            uptime: 100,
          }}
        />
      </div>
      <div id="audit-quota-panel">
        <QuotaPanel
          quota={{
            refreshing: false,
            rows: [
              {
                provider: "provider",
                name: "Provider",
                availability: "available",
                observedAt: NOW,
                windows: [{ label: "5h", usedPct: 40 }],
              },
            ],
          }}
          now={NOW}
          connected
        />
      </div>
      <div id="audit-quota-empty">
        <QuotaPanel quota={{ refreshing: false, rows: [] }} now={NOW} refresh={no} connected />
      </div>
      <div id="audit-ap-collapsed" style={{ width: "min(380px, 100%)" }}>
        {panel({ overview: true })}
      </div>
      <div id="audit-ap-collapsed-busy" style={{ width: "min(380px, 100%)" }}>
        {panel({ sessions: [busySession()], overview: true })}
      </div>
      <div id="audit-ap-expanded" style={{ width: "min(380px, 100%)" }}>
        {panel()}
      </div>
      <div id="audit-ap-expanded-readonly" style={{ width: "min(380px, 100%)" }}>
        {panel({ project: { ...project, status: "sealed", sealedReason: "Audit complete" } })}
      </div>
      <div id="audit-bp-card">
        <button className="bp-card">
          <span className="bp-card-top">
            <span className="bp-id">obj-1</span>
          </span>
          <span className="bp-card-title">Balanced cards</span>
          <span className="bp-card-goal">Keep content evenly inset</span>
          <span className="bp-card-foot">
            <span className="bp-stage stage-ready">ready</span>
          </span>
        </button>
      </div>
      <div id="audit-bp-node">
        <button className="bp-node">
          <span className="bp-node-title">Balanced cards</span>
          <span className="bp-node-meta">obj-1</span>
        </button>
      </div>
      <div id="audit-bi-row">
        <button className="bi-row">
          <span className="bi-row-top">
            <span className="bi-evidence ev-R">R</span>
            <span className="bp-id">issue-1</span>
          </span>
          <span className="bi-row-text">Inspect border spacing</span>
        </button>
      </div>
      <div id="audit-usage-card">
        <div className="usage-card">
          <h3>Total tokens</h3>
          <strong>1.2K</strong>
          <p>1K prompt · 200 output</p>
        </div>
      </div>
      <div id="audit-stats">
        <SessionStats workspaceId="worker" connected agents={[]} />
      </div>
      <div id="audit-dialog">
        <div className="dialog">
          <h2 className="dialog-title">Confirm</h2>
          <div className="dialog-body">Continue with the audit?</div>
          <div className="dialog-actions">
            <button className="btn-secondary">Cancel</button>
            <button className="btn-primary">Confirm</button>
          </div>
        </div>
      </div>
      <div id="audit-command-popup">
        <div className="command-popup">
          <div className="command-item">
            <span className="command-name">/help</span>
            <span className="command-desc">Show help</span>
          </div>
        </div>
      </div>
      <div id="audit-ui-option">
        <button className="ui-dialog-option">Continue</button>
      </div>
      <div id="audit-ui-alert">
        <div className="ui-dialog-alert">
          <span>Approval required</span>
          <button>Approve</button>
        </div>
      </div>
    </div>,
  );

  await expect
    .poll(() => document.querySelectorAll("#audit-stats .session-stats-turn").length)
    .toBe(4);
  const statsTurns = document.querySelectorAll<HTMLElement>("#audit-stats .session-stats-turn");
  for (const index of [1, 2, 3])
    fireEvent.click(statsTurns[index].querySelector(":scope > summary")!);
  fireEvent.click(statsTurns[3].querySelector(".session-stats-step > summary")!);

  fireEvent.click(document.querySelector("#audit-banner-list .banner-toggle")!);
  fireEvent.click(document.querySelector("#audit-banner-schedule .banner-toggle")!);
  const collapsedQuota = contentInsets(
    document.querySelector<HTMLElement>("#audit-quota-panel > .quota-panel")!,
  );
  fireEvent.click(document.querySelector("#audit-quota-panel .quota-row-toggle")!);

  function expectBalanced(name: string, { top, bottom }: ReturnType<typeof contentInsets>) {
    expect
      .soft(Math.abs(top - bottom), `${name}: top=${top}, bottom=${bottom}`)
      .toBeLessThanOrEqual(1.5);
  }
  expectBalanced("quota-collapsed", collapsedQuota);
  for (const name of Object.keys(selectors) as (keyof typeof selectors)[]) {
    const selector = selectors[name];
    const element = document.querySelector<HTMLElement>(selector)!;
    expect(element, selector).not.toBeNull();
    const sections = flowSections[name];
    expectBalanced(name, contentInsets(element, sections));
    if (!sections) continue;

    // A gap after the last section must be detected even with unchanged padding.
    // Extend past the adjacent icon, which can be taller than the banner text.
    const last = [...element.querySelectorAll<HTMLElement>(sections)].at(-1)!;
    last.style.marginBottom = "8px";
    const { top, bottom } = contentInsets(element, sections);
    expect.soft(bottom - top, `${name}: extra space after ${last.className}`).toBeGreaterThan(1.5);
    last.style.removeProperty("margin-bottom");
  }
});

// Read ink from a themed Chromium crop without font- or platform-specific snapshots.
async function inkBounds(label: HTMLElement) {
  const base64 = await page.elementLocator(label).screenshot({ save: false, scale: "css" });
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // At rest the top-left pixel is the unpainted label/button background.
  let left = image.width,
    right = 0,
    top = image.height,
    bottom = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = 4 * (y * image.width + x);
      if ([0, 1, 2].every((c) => Math.abs(data[i + c] - data[c]) < 28)) continue;
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
  }
  expect(bottom).toBeGreaterThan(top);
  const box = label.getBoundingClientRect();
  // The Vitest runner can scale its iframe to fit the host viewport.
  const sx = box.width / image.width,
    sy = box.height / image.height;
  return {
    left: box.left + left * sx,
    right: box.left + right * sx,
    top: box.top + top * sy,
    bottom: box.top + bottom * sy,
  };
}

function footerImbalance(card: HTMLElement, mark: { top: number; bottom: number }) {
  const foot = card.querySelector<HTMLElement>(".ap-session-foot")!;
  return Math.abs(
    mark.top -
      foot.getBoundingClientRect().top -
      foot.clientTop -
      (card.getBoundingClientRect().bottom -
        parseFloat(getComputedStyle(card).borderBottomWidth) -
        mark.bottom),
  );
}

function contourGap(card: HTMLElement, button: HTMLElement, leading: boolean) {
  const cardBox = card.getBoundingClientRect(),
    box = button.getBoundingClientRect();
  const style = getComputedStyle(button);
  const outset =
    style.outlineStyle === "none"
      ? 0
      : Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
  // The active inset shadow paints the first two pixels inside the border.
  return (
    (leading
      ? box.left - cardBox.left - card.clientLeft - (card.classList.contains("active") ? 2 : 0)
      : cardBox.right - box.right - parseFloat(getComputedStyle(card).borderRightWidth)) - outset
  );
}

it.each([390, 1280].flatMap((width) => ["light", "dark"].map((theme) => ({ width, theme }))))(
  "separates footer ink, section rhythm and action contours at $width in $theme",
  async ({ width, theme }) => {
    await page.viewport(width, 844);
    const previous = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = theme;
    try {
      const view = (active: boolean, folded = false, sealed = false) => (
        <div style={{ width: 350 }}>
          {panel({
            sessions: [busySession()],
            project: sealed ? { ...project, status: "sealed" } : project,
            activeWsId: active ? workspace.id : null,
            overview: folded,
          })}
        </div>
      );
      const { container, rerender } = render(view(true));
      for (const active of [true, false])
        for (const folded of [false, true]) {
          rerender(view(active, folded));
          const card = container.querySelector<HTMLElement>(".ap-session")!;
          for (const button of card.querySelectorAll<HTMLButtonElement>(
            ".ap-add,.ap-actions > :last-child",
          )) {
            await page.elementLocator(card.querySelector("header")!).hover();
            const leading = button.classList.contains("ap-add");
            const ink = await inkBounds(button);
            const axis = card
              .querySelector(leading ? ".ap-agents" : ".ap-when")!
              .getBoundingClientRect();
            expect(
              Math.abs(leading ? ink.left - axis.left - 12 : axis.right - ink.right),
              `${button.textContent} resting ink axis, folded=${folded}`,
            ).toBeLessThanOrEqual(2);
            // Rendered glyphs have different ascenders/descenders; a few pixels
            // of optical variation are independent of the symmetric button contour.
            if (!folded)
              expect(footerImbalance(card, ink), button.textContent).toBeLessThanOrEqual(5);
            if (matchMedia("(hover: hover)").matches) {
              await page.elementLocator(button).hover();
              expect(getComputedStyle(button).borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
              expect(contourGap(card, button, leading)).toBeGreaterThanOrEqual(4);
              if (!folded)
                expect(footerImbalance(card, button.getBoundingClientRect())).toBeLessThanOrEqual(
                  1,
                );
            }
            await userEvent.keyboard("{Tab}");
            button.focus();
            expect(button.matches(":focus-visible")).toBe(true);
            expect(getComputedStyle(button).outlineStyle).not.toBe("none");
            expect(contourGap(card, button, leading)).toBeGreaterThanOrEqual(4);
            button.blur();
          }
        }
      rerender(view(true, false, true));
      const card = container.querySelector<HTMLElement>(".ap-session")!;
      expect(
        footerImbalance(card, await inkBounds(card.querySelector(".ap-readonly")!)),
        "sealed label",
      ).toBeLessThanOrEqual(4);
    } finally {
      if (previous === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previous;
    }
  },
);

it("rejects section and contour regressions hidden by outer-box and resting-label checks", async () => {
  await page.viewport(1280, 900);
  const { container } = render(panel());
  const card = container.querySelector<HTMLElement>(".ap-session")!;
  const foot = card.querySelector<HTMLElement>("footer")!;
  const add = foot.querySelector<HTMLElement>(".ap-add")!;
  foot.style.paddingBlock = "4px 10px";
  const outer = contentInsets(card);
  expect(Math.abs(outer.top - outer.bottom)).toBeLessThanOrEqual(1.5);
  expect(footerImbalance(card, add.getBoundingClientRect())).toBeGreaterThan(1.5);
  const rest = await inkBounds(add);
  add.style.paddingLeft = "8px";
  add.style.marginLeft = "-9px";
  expect(Math.abs((await inkBounds(add)).left - rest.left)).toBeLessThanOrEqual(1);
  expect(add.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
  await page.elementLocator(add).hover();
  expect(getComputedStyle(add).borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(contourGap(card, add, true)).toBeLessThan(4);
});

it("keeps the mobile collapsed Stop target inside its card and clickable", async () => {
  await page.viewport(390, 844);
  const stop = vi.fn();
  render(
    <div style={{ width: 350, height: 200, overflowY: "auto" }}>
      <div style={{ height: 400 }} />
      {panel({ sessions: [busySession()], actions: { ...actions, onStop: stop }, overview: true })}
    </div>,
  );
  const button = document.querySelector<HTMLElement>(".ap-brief .panel-btn")!;
  button.scrollIntoView({ block: "center" });
  expect(button.closest(".agents-panel")!.parentElement!.scrollTop).toBeGreaterThan(0);
  const buttonBounds = button.getBoundingClientRect();
  const card = document.querySelector<HTMLElement>(".ap-session")!;
  const cardBounds = card.getBoundingClientRect();
  expect(buttonBounds.height).toBeGreaterThanOrEqual(40);
  expect(buttonBounds.top).toBeGreaterThanOrEqual(cardBounds.top + card.clientTop - 0.01);
  expect(buttonBounds.bottom).toBeLessThanOrEqual(
    cardBounds.bottom - parseFloat(getComputedStyle(card).borderBottomWidth) + 0.01,
  );
  await page.elementLocator(button).click();
  expect(stop).toHaveBeenCalledOnce();
});
