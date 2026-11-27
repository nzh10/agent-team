import type { AgentInfo, RunState } from "../state/useServer";

type Rgb = readonly [number, number, number];

// These mirror the theme tokens measured in theme-contrast.browser.test.ts.
// A 4.55 target leaves room for the browser's 8-bit color-mix rounding.
const NAME_THEMES = {
  light: {
    text: [0x25, 0x2a, 0x32],
    surfaces: ["ffffff", "f2f2f2", "f7f8fa"],
    highlight: ["0099ff", "ffffff"],
  },
  dark: {
    text: [0xdf, 0xdf, 0xdf],
    surfaces: ["1b1b1d", "141416", "242428", "2e2e33"],
    highlight: ["0099ff", "1b1b1d"],
  },
} as const;

function hexRgb(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function profileRgb(color: string): { hex: string; rgb: Rgb } | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return { hex: `#${hex.toLowerCase()}`, rgb: hexRgb(hex) };
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function mixRgb(rgb: Rgb, anchor: Rgb, weight: number): Rgb {
  const channel = (i: 0 | 1 | 2) =>
    Math.round((rgb[i] * weight + anchor[i] * (100 - weight)) / 100);
  return [channel(0), channel(1), channel(2)];
}

function nameWeight(rgb: Rgb, theme: (typeof NAME_THEMES)[keyof typeof NAME_THEMES]): number {
  const surfaces = [
    ...theme.surfaces.map(hexRgb),
    // The peak of .message-highlight's 22% accent overlay on bg-primary.
    mixRgb(hexRgb(theme.highlight[0]), hexRgb(theme.highlight[1]), 22),
  ];
  let best = 0;
  // Check every integer instead of assuming a mixed hue's luminance is
  // monotonic. This bounds every opaque sRGB profile, not just the presets.
  for (let weight = 0; weight <= 100; weight += 1) {
    const mixed = mixRgb(rgb, theme.text, weight);
    if (surfaces.every((surface) => contrast(mixed, surface) >= 4.55)) best = weight;
  }
  return best;
}

const nameColors = new Map<string, string>();

// Preserve as much profile identity as WCAG 4.5:1 permits on every theme
// surface. Unsupported or translucent input falls back to readable text.
export function agentNameColor(color: string): string {
  const profile = profileRgb(color);
  if (!profile) return "var(--text-primary)";
  let result = nameColors.get(profile.hex);
  if (!result) {
    // One weight must be safe in both themes: this also works in Canvas and
    // browsers without light-dark(), while the text anchor still follows the theme.
    const weight = Math.min(
      nameWeight(profile.rgb, NAME_THEMES.light),
      nameWeight(profile.rgb, NAME_THEMES.dark),
    );
    result = `color-mix(in srgb, ${profile.hex} ${weight}%, var(--text-primary))`;
    nameColors.set(profile.hex, result);
  }
  return result;
}

// Effective run state of an agent. Servers that predate `state` only send
// the busy flag, so derive from it.
export function agentState(a: AgentInfo): RunState {
  if (a.state) return a.state;
  return a.busy ? "working" : "idle";
}

// "Something is going on": the agent is in a turn, or background work will
// re-invoke it. Drives the sidebar pulse and the archive guard.
export function isAgentActive(a: AgentInfo): boolean {
  const s = agentState(a);
  return s === "working" || s === "waiting";
}

// Only a turn in progress makes the composer queue instead of send: waiting
// and sleeping agents accept a new prompt immediately.
export function agentQueues(a: AgentInfo): boolean {
  return agentState(a) === "working";
}

// Label for the header pill: one word per state. Working keeps its short
// activity ("compacting context"); what a sleeping agent waits for is in
// the transcript, not squeezed into the pill.
export function pillLabel(a: AgentInfo, connected: boolean): string {
  const s = agentState(a);
  if (s === "working") return a.activity ?? "working";
  if (s === "waiting") return "waiting";
  if (s === "sleeping") return "sleeping";
  return connected ? "online" : "offline";
}

// Full label for the message header: includes the activity text.
export function stateLabel(a: AgentInfo, connected: boolean): string {
  const s = agentState(a);
  if (s === "working") return a.activity ?? "working";
  if (s === "waiting") return a.activity ?? "waiting on background work";
  if (s === "sleeping") return a.activity ?? "sleeping";
  return connected ? "online" : "offline";
}
