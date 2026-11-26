// Guards the contract between docs/UI_ZEN.md and the webview vocabulary:
// canonical tokens, documented selectors/files/symbols, nested flatness, and
// optical/touch geometry rules stay synchronized without noisy blanket checks.
import { describe, expect, it } from "vitest";
import uiZen from "../../docs/UI_ZEN.md?raw";
import messagesSrc from "../src/chat/messages.tsx?raw";
import changesViewSrc from "../src/panels/ChangesView.tsx?raw";
import filesPanelSrc from "../src/panels/FilesPanel.tsx?raw";
import sidePanelSrc from "../src/panels/SidePanel.tsx?raw";
import projectPartsSrc from "../src/project/parts.tsx?raw";
import css from "../src/styles.css?raw";
import usageOverviewCss from "../src/usage/UsageOverview.css?raw";
import dialogFrameSrc from "../src/workspace/DialogFrame.tsx?raw";

interface CssRule {
  selectors: string[];
  body: string;
  media: string | null;
}

const PHONE_MEDIA = "@media (max-width: 768px), (max-height: 500px)";

function splitSelectors(head: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "," && parenDepth === 0 && bracketDepth === 0) {
      const part = head.slice(start, i).trim();
      if (part) selectors.push(part);
      start = i + 1;
    }
  }
  const tail = head.slice(start).trim();
  if (tail) selectors.push(tail);
  return selectors;
}

function parseRules(text: string, media: string | null = null): CssRule[] {
  const out: CssRule[] = [];
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;

    const open = src.indexOf("{", i);
    const semi = src.indexOf(";", i);
    if (semi >= 0 && (open < 0 || semi < open)) {
      i = semi + 1;
      continue;
    }
    if (open < 0) break;

    const head = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (depth > 0 && j < src.length) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);
    if (head.startsWith("@media")) {
      out.push(...parseRules(body, head));
    } else if (
      head.startsWith("@supports") ||
      head.startsWith("@container") ||
      head.startsWith("@layer")
    ) {
      out.push(...parseRules(body, media));
    } else if (!head.startsWith("@keyframes")) {
      out.push({ selectors: splitSelectors(head), body, media });
    }
    i = j;
  }
  return out;
}

function extractPxTokens(body: string, prefix: string): Record<string, number> {
  const pattern = new RegExp(`--(${prefix}[\\w-]+):\\s*([\\d.]+)px\\b`, "g");
  return Object.fromEntries([...body.matchAll(pattern)].map((m) => [m[1], Number(m[2])]));
}

function extractDefinedCustomProps(body: string): Set<string> {
  return new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
}

function extractClassNames(selector: string): string[] {
  return [...selector.matchAll(/\.[a-z_][\w-]*/gi)].map((m) => m[0]);
}

function hasDeclaration(body: string, property: string, valuePattern: RegExp): boolean {
  for (const decl of body.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim();
    const val = decl.slice(colon + 1).trim();
    if (prop === property && valuePattern.test(val)) return true;
  }
  return false;
}

function isRootSelector(selector: string): boolean {
  return selector === ":root" || selector.startsWith(":root[");
}

function findRule(
  rules: CssRule[],
  selector: string,
  media: string | null = null,
): CssRule | undefined {
  return rules.find((r) => r.media === media && r.selectors.includes(selector));
}

const rules = parseRules(css);
const allSelectorClasses = new Set(
  rules.flatMap((rule) => rule.selectors.flatMap((selector) => extractClassNames(selector))),
);
const allDefinedProps = new Set(rules.flatMap((rule) => [...extractDefinedCustomProps(rule.body)]));

const backtickSpans = new Set([...uiZen.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()));
const documentedClasses = new Set(
  [...backtickSpans]
    .filter((span) => /^\.[a-z_][\w-]*(?:\s+\.[a-z_][\w-]*)*$/i.test(span))
    .flatMap((span) => extractClassNames(span)),
);

const webviewSrcFiles = new Set(Object.keys(import.meta.glob("../src/**/*.{ts,tsx,css}")));
// Vite omits the importing module itself from import.meta.glob.
const webviewTestFiles = new Set([
  "./ui-vocabulary.test.ts",
  ...Object.keys(import.meta.glob("./**/*.{ts,tsx}")),
]);

describe("UI Zen vocabulary contract", () => {
  it("defines the canonical :root typography scale, mobile step-up, and component consumption", () => {
    const expectedOrder = ["fs-name", "fs-text", "fs-meta", "fs-tag"] as const;
    const expectedSorted = [...expectedOrder].sort();
    const desktopRoot = findRule(rules, ":root", null);
    const phoneRoot = findRule(rules, ":root", PHONE_MEDIA);
    expect(desktopRoot, "desktop :root rule").toBeDefined();
    expect(phoneRoot, `mobile ${PHONE_MEDIA} :root rule`).toBeDefined();

    const desktop = extractPxTokens(desktopRoot!.body, "fs-");
    const phone = extractPxTokens(phoneRoot!.body, "fs-");

    // Check the exact token set independently of source declaration order.
    expect(Object.keys(desktop).sort()).toEqual(expectedSorted);
    expect(Object.keys(phone).sort()).toEqual(expectedSorted);

    for (let i = 0; i < expectedOrder.length; i++) {
      const token = expectedOrder[i];
      expect(desktop[token], `desktop --${token}`).toBeGreaterThan(0);
      expect(phone[token], `mobile --${token} > desktop`).toBeGreaterThan(desktop[token]);
      if (i > 0) {
        const prev = expectedOrder[i - 1];
        expect(desktop[prev], `desktop --${prev} > --${token}`).toBeGreaterThan(desktop[token]);
        expect(phone[prev], `mobile --${prev} > --${token}`).toBeGreaterThan(phone[token]);
      }
    }

    // Distinguish :root definitions from component consumption.
    const componentRules = rules.filter((r) => !r.selectors.every(isRootSelector));
    for (const token of expectedOrder) {
      const consumed = componentRules.some((r) => new RegExp(`var\\(--${token}\\b`).test(r.body));
      expect(consumed, `component rule consuming var(--${token})`).toBe(true);
    }
  });

  it("keeps every control, surface, and geometry selector referenced in docs/UI_ZEN.md in sync with styles.css", () => {
    const requiredSelectors = [
      ".btn-inline",
      ".panel-btn",
      ".btn-primary",
      ".btn-secondary",
      ".btn-danger",
      ".btn-ghost",
      ".bp-chip",
      ".side-panel",
      ".dialog",
      ".ap-toggle",
      ".subagent-item",
      ".subagent-details",
      ".ap-session",
      ".ap-work",
    ];
    for (const selector of requiredSelectors) {
      expect(documentedClasses.has(selector), `docs/UI_ZEN.md documents ${selector}`).toBe(true);
      expect(allSelectorClasses.has(selector), `styles.css defines ${selector}`).toBe(true);
    }

    // Guard against any stale backticked CSS class or custom property in docs/UI_ZEN.md.
    for (const cls of documentedClasses) {
      expect(allSelectorClasses.has(cls), `documented selector ${cls} exists in styles.css`).toBe(
        true,
      );
    }
    for (const span of backtickSpans) {
      if (/^--[a-z0-9-]+$/i.test(span)) {
        expect(allDefinedProps.has(span), `documented token ${span} exists in styles.css`).toBe(
          true,
        );
      }
    }
  });

  it("verifies every webview file and component symbol referenced in docs/UI_ZEN.md exists", () => {
    const referencedFiles = [...backtickSpans].filter((span) =>
      /^webview\/(?:src|tests)\/\S+$/.test(span),
    );
    expect(referencedFiles.length).toBeGreaterThan(0);

    for (const file of referencedFiles) {
      if (file.startsWith("webview/src/")) {
        const key = `../src/${file.slice("webview/src/".length)}`;
        expect(webviewSrcFiles.has(key), `referenced source file ${file}`).toBe(true);
      } else if (file.startsWith("webview/tests/")) {
        const key = `./${file.slice("webview/tests/".length)}`;
        expect(webviewTestFiles.has(key), `referenced test file ${file}`).toBe(true);
      }
    }

    const expectedExports: Array<{ file: string; source: string; symbols: string[] }> = [
      {
        file: "webview/src/chat/messages.tsx",
        source: messagesSrc,
        symbols: ["EventItem", "SubAgentItem"],
      },
      {
        file: "webview/src/panels/SidePanel.tsx",
        source: sidePanelSrc,
        symbols: ["SidePanel"],
      },
      {
        file: "webview/src/panels/FilesPanel.tsx",
        source: filesPanelSrc,
        symbols: ["FilesPanel"],
      },
      {
        file: "webview/src/panels/ChangesView.tsx",
        source: changesViewSrc,
        symbols: ["ChangesList", "DiffView"],
      },
      {
        file: "webview/src/workspace/DialogFrame.tsx",
        source: dialogFrameSrc,
        symbols: ["DialogFrame"],
      },
      {
        file: "webview/src/project/parts.tsx",
        source: projectPartsSrc,
        symbols: ["FilterChip"],
      },
    ];

    for (const { file, source, symbols } of expectedExports) {
      expect(backtickSpans.has(file), `docs/UI_ZEN.md references ${file}`).toBe(true);
      for (const symbol of symbols) {
        expect(backtickSpans.has(symbol), `docs/UI_ZEN.md references ${symbol}`).toBe(true);
        expect(
          new RegExp(`export\\s+(?:const|function)\\s+${symbol}\\b`).test(source),
          `${file} exports ${symbol}`,
        ).toBe(true);
      }
    }

    // FilterChip renders the canonical .bp-chip class.
    expect(projectPartsSrc).toContain('"bp-chip"');
  });

  it("keeps Usage typography, static text colors, and numeric alignment on semantic tokens", () => {
    const usageRules = [...rules, ...parseRules(usageOverviewCss)].filter((rule) =>
      rule.selectors.some((selector) => selector.includes(".usage-")),
    );
    const heroSelector = ".usage-kpis .usage-card > strong";
    let fontSizeCount = 0;
    for (const rule of usageRules) {
      for (const match of rule.body.matchAll(/(?:^|;)\s*font-size\s*:\s*([^;]+)/g)) {
        fontSizeCount++;
        if (rule.selectors.includes(heroSelector)) {
          expect(match[1].trim(), heroSelector).toBe("clamp(16px, 3vw, 25px)");
        } else {
          expect(match[1].trim(), rule.selectors.join(", ")).toMatch(
            /^var\(--fs-(?:name|text|meta|tag)\)$/,
          );
        }
      }
    }
    expect(fontSizeCount, "Usage font-size declarations checked").toBeGreaterThan(0);

    const pageInput = findRule(usageRules, ".usage-pages input");
    expect(pageInput, ".usage-pages input rule").toBeDefined();
    expect(hasDeclaration(pageInput!.body, "font", /^inherit$/)).toBe(true);

    const filterLink = findRule(usageRules, ".usage-filter-link");
    const disclosure = findRule(usageRules, ".usage-row summary::after");
    expect(filterLink, ".usage-filter-link rule").toBeDefined();
    expect(disclosure, ".usage-row summary::after rule").toBeDefined();
    expect(hasDeclaration(filterLink!.body, "color", /^var\(--accent-text\)$/)).toBe(true);
    expect(hasDeclaration(disclosure!.body, "color", /^var\(--text-muted\)$/)).toBe(true);

    for (const selector of [
      ".usage-row-total",
      heroSelector,
      ".usage-prices dd",
      ".usage-method dd",
      ".usage-axis",
      ".usage-overview-rank-label strong",
      ".usage-pages > span",
      ".usage-pages input",
    ]) {
      expect(
        usageRules.some(
          (rule) =>
            rule.media === null &&
            rule.selectors.includes(selector) &&
            hasDeclaration(rule.body, "font-variant-numeric", /^tabular-nums$/),
        ),
        `${selector} uses tabular-nums`,
      ).toBe(true);
    }
  });

  it("preserves nested flatness inside tinted status containers and optical/touch geometry rules", () => {
    const nestedSubagent = findRule(rules, ".subagent-item .subagent-item", null);
    expect(nestedSubagent, ".subagent-item .subagent-item rule").toBeDefined();
    expect(hasDeclaration(nestedSubagent!.body, "background", /^transparent$/)).toBe(true);

    for (const selector of [
      ".subagent-details .event",
      ".subagent-details .subagent-prompt",
      ".subagent-details .subagent-summary",
      ".subagent-details .subagent-item",
      ".subagent-details .banner",
    ]) {
      const rule = findRule(rules, selector, null);
      expect(rule, `${selector} flatness rule`).toBeDefined();
      expect(hasDeclaration(rule!.body, "background", /^transparent$/)).toBe(true);
    }

    // Un-tinted .ap-session keeps primary canvas so .ap-work may distinguish an inner focus block.
    const apSession = findRule(rules, ".ap-session", null);
    const apWork = findRule(rules, ".ap-work", null);
    expect(apSession).toBeDefined();
    expect(apWork).toBeDefined();
    expect(hasDeclaration(apSession!.body, "background", /^var\(--bg-primary\)$/)).toBe(true);
    expect(hasDeclaration(apWork!.body, "background", /^var\(--bg-secondary\)$/)).toBe(true);

    // Frameless mobile touch hit target for .ap-toggle without bloating card padding.
    const desktopToggle = findRule(rules, ".ap-toggle", null);
    expect(desktopToggle, "desktop .ap-toggle rule").toBeDefined();
    expect(hasDeclaration(desktopToggle!.body, "background", /^none$/)).toBe(true);
    expect(hasDeclaration(desktopToggle!.body, "border", /^none$/)).toBe(true);

    const mobileToggle = findRule(rules, ".ap-toggle", PHONE_MEDIA);
    expect(mobileToggle, `mobile ${PHONE_MEDIA} .ap-toggle rule`).toBeDefined();
    const width = Number(/width:\s*([\d.]+)px/.exec(mobileToggle!.body)?.[1]);
    const height = Number(/height:\s*([\d.]+)px/.exec(mobileToggle!.body)?.[1]);
    expect(width).toBeGreaterThanOrEqual(32);
    expect(height).toBeGreaterThanOrEqual(32);
    expect(hasDeclaration(mobileToggle!.body, "margin", /^-\d+px/)).toBe(true);
  });
});
