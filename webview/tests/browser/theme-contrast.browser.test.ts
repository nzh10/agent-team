import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { agentNameColor } from "../../src/workspace/agents";
import "../../src/styles.css";

// WCAG 2.x relative luminance (sRGB). Canvas resolves color-mix and composites
// translucent fills over their host, so chips are measured as actually painted.
function luminance(channels: Uint8ClampedArray) {
  const [r, g, b] = Array.from(channels.slice(0, 3), (byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastCss(foreground: string, ...background: string[]) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, 1, 1);
  for (const fill of background) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, 1, 1);
  }
  const a = luminance(ctx.getImageData(0, 0, 1, 1).data);
  ctx.fillStyle = foreground;
  ctx.fillRect(0, 0, 1, 1);
  const b = luminance(ctx.getImageData(0, 0, 1, 1).data);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("--test-agent-name");
});

it.each(["light", "dark"])("keeps %s theme colors above their contrast floors", (theme) => {
  document.documentElement.dataset.theme = theme;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const styles = getComputedStyle(document.documentElement);
  const painted = (stack: string[]) => {
    ctx.clearRect(0, 0, 1, 1);
    for (const token of stack) {
      const value = styles.getPropertyValue(`--${token}`).trim();
      expect(CSS.supports("color", value), `--${token}: ${value}`).toBe(true);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
    }
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    expect(pixel[3], stack.join(" + ")).toBe(255);
    return luminance(pixel);
  };
  const passes = (foreground: string, ...background: string[]) => {
    const a = painted(background);
    const b = painted([...background, foreground]);
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const minimum =
      background.length === 1 && background[0].startsWith("bg-")
        ? foreground === "text-strong"
          ? 9
          : foreground === "text-primary"
            ? 6
            : 4.5
        : 4.5;
    expect(contrast, `${foreground} on ${background.join(" + ")}`).toBeGreaterThanOrEqual(minimum);
  };

  const passesAtLeast = (minimum: number, foreground: string, ...background: string[]) => {
    const a = painted(background);
    const b = painted([...background, foreground]);
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    expect(contrast, `${foreground} on ${background.join(" + ")}`).toBeGreaterThanOrEqual(minimum);
  };

  const text = [
    "text-strong",
    "text-primary",
    "text-body",
    "text-secondary",
    "text-muted",
    "accent-text",
  ];
  for (const surface of ["bg-primary", "bg-secondary", "bg-tertiary", "bg-elevated"]) {
    for (const fg of text) {
      passes(fg, surface);
      passes(fg, surface, "bg-active");
      passes(fg, surface, "bg-hover");
    }
    passes("accent-text", surface, "accent-soft");
    for (const status of ["success", "warning", "error", "purple"]) {
      passes(status, surface);
      passes(status, surface, `${status}-soft`);
    }
  }
  for (const fg of [
    "text-body",
    "text-muted",
    "syntax-keyword",
    "syntax-string",
    "syntax-literal",
    "syntax-symbol",
    "syntax-name",
  ]) {
    passes(fg, "bg-tertiary");
    passes(fg, "bg-tertiary", "success-soft");
    passes(fg, "bg-tertiary", "error-soft");
  }
  passes("text-muted", "bg-tertiary", "accent-soft"); // Diff hunk header and sticky gutter.
  // Light's approved QQ-blue brand fill is a documented 3:1 exception, not AA text.
  // Dark brand fills, and every other normal text pair, remain strict 4.5:1.
  const brandFillMinimum = theme === "light" ? 3 : 4.5;
  for (const fill of ["accent-solid", "accent-hover"]) {
    passesAtLeast(brandFillMinimum, "on-solid", fill);
  }
  passes("on-error", "error");

  for (const surface of ["bg-primary", "bg-secondary", "bg-tertiary", "bg-elevated"]) {
    passesAtLeast(3, "focus-ring", surface);
  }
  // Active-row titles/icons/status indicators share the solid brand fill above.
  // Their glass attention/unread/silence pills and nested actions require strict text AA.
  for (const fill of ["active-row-pill", "active-row-pill-hover"]) {
    passesAtLeast(4.5, "on-solid", "accent-solid", fill);
  }

  // Nested row actions keep their label/icon readable over both hover layers.
  for (const fg of ["text-primary", "text-secondary", "accent-action-text", "error"]) {
    passes(fg, "bg-secondary", "bg-hover-strong");
    passes(fg, "bg-secondary", "bg-hover", "bg-hover-strong");
  }
  const hoveredRow = painted(["bg-secondary", "bg-hover"]);
  const hoveredAction = painted(["bg-secondary", "bg-hover", "bg-hover-strong"]);
  const separation =
    (Math.max(hoveredRow, hoveredAction) + 0.05) / (Math.min(hoveredRow, hoveredAction) + 0.05);
  expect(separation, `${theme}: nested hover surface distinction`).toBeGreaterThan(1.1);
  if (theme === "dark") {
    const restingRow = painted(["bg-secondary"]);
    expect((hoveredRow + 0.05) / (restingRow + 0.05)).toBeGreaterThan(1.03);
  }

  const profileColors = [
    "#ffffff",
    "#000000",
    "#528bff",
    "#e5c07b",
    "#c678dd",
    "#D8A0D8",
    "#8AB4F8",
    "#C0C0C0",
    "#7DD3FC",
    "#A5B4FC",
  ];
  for (const profileColor of profileColors) {
    document.documentElement.style.setProperty("--test-agent-name", agentNameColor(profileColor));
    for (const surface of ["bg-primary", "bg-secondary", "bg-tertiary", "bg-elevated"]) {
      passes("test-agent-name", surface);
    }
    // Jump-highlight animation peak: 22% accent over the transcript canvas.
    passes("test-agent-name", "bg-primary", "bg-highlight");
  }
});

it.each(["light", "dark"])("uses the focus token on %s focus-only field borders", async (theme) => {
  document.documentElement.dataset.theme = theme;
  const host = document.createElement("div");
  host.innerHTML = `
    <div class="search-bar"><input aria-label="Search" /></div>
    <div class="input-row"><textarea aria-label="Composer"></textarea></div>
    <div class="dialog-field"><input aria-label="Dialog input" /><select aria-label="Dialog select"></select></div>
    <input class="bp-search" aria-label="Board search" />
    <div class="dialog-field"><textarea class="ui-dialog-editor" aria-label="Dialog editor"></textarea></div>
    <button class="ui-dialog-option">Option</button>
  `;
  document.body.append(host);
  const colorProbe = document.createElement("span");
  colorProbe.style.color = "var(--focus-ring)";
  host.append(colorProbe);
  const focusColor = getComputedStyle(colorProbe).color;
  colorProbe.remove();
  const fields = [
    [".search-bar input", ".search-bar input"],
    [".input-row", ".input-row textarea"],
    [".dialog-field input", ".dialog-field input"],
    [".dialog-field select", ".dialog-field select"],
    [".bp-search", ".bp-search"],
    [".ui-dialog-editor", ".ui-dialog-editor"],
    [".ui-dialog-option", ".ui-dialog-option"],
  ];
  try {
    for (const [targetSelector, focusSelector] of fields) {
      await userEvent.tab();
      const focused = host.querySelector<HTMLElement>(focusSelector)!;
      expect(document.activeElement).toBe(focused);
      const target = host.querySelector<HTMLElement>(targetSelector)!;
      await expect
        .poll(() => getComputedStyle(target).borderTopColor, { message: targetSelector })
        .toBe(focusColor);
      const style = getComputedStyle(target);
      expect(
        contrastCss(
          style.borderTopColor,
          getComputedStyle(document.body).backgroundColor,
          style.backgroundColor,
        ),
        targetSelector,
      ).toBeGreaterThanOrEqual(3);
    }
  } finally {
    (document.activeElement as HTMLElement | null)?.blur();
    host.remove();
  }
});
