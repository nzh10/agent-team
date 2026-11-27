import mermaid from "mermaid";
import type { DiagramTheme } from "./DiagramPreview";

let nextId = 0;
let queue: Promise<unknown> = Promise.resolve();

function hasImageNode(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Map) {
    for (const child of value.values()) if (hasImageNode(child, seen)) return true;
    return false;
  }
  if (value instanceof Set) {
    for (const child of value) if (hasImageNode(child, seen)) return true;
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "img" && typeof child === "string" && child.trim()) return true;
    if (hasImageNode(child, seen)) return true;
  }
  return false;
}

async function render(source: string, theme: DiagramTheme): Promise<string> {
  const rootStyle = getComputedStyle(document.documentElement);
  const token = (name: string) => rootStyle.getPropertyValue(name).trim();
  const dark = theme === "dark";
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "htmlLabels",
      "suppressErrorRendering",
      "dompurifyConfig",
      "maxTextSize",
      "maxEdges",
      "theme",
      "themeVariables",
      "themeCSS",
    ],
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: 50_000,
    maxEdges: 500,
    theme: dark ? "dark" : "default",
    darkMode: dark,
    fontFamily: token("--font-mono"),
    themeVariables: {
      useGradient: false,
      dropShadow: "none",
      background: token("--bg-tertiary"),
      primaryColor: token("--bg-elevated"),
      primaryTextColor: token("--text-primary"),
      primaryBorderColor: token("--border-strong"),
      lineColor: token("--text-secondary"),
      tertiaryColor: token("--bg-tertiary"),
      textColor: token("--text-primary"),
      mainBkg: token("--bg-elevated"),
      nodeBorder: token("--border-strong"),
      clusterBkg: token("--bg-tertiary"),
      clusterBorder: token("--border"),
      edgeLabelBackground: token("--bg-tertiary"),
    },
  });
  // Mermaid decodes image nodes before returning SVG, so sanitizing its output
  // alone cannot prevent the request. Parse first and never draw those nodes.
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  if (hasImageNode(diagram.db)) throw new Error("Image nodes are disabled in diagram previews");
  // Mermaid looks up live SVG nodes by ID and measures text. Keep them connected
  // but out of the body's flow and scroll range until the SVG is serialized.
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    left: "-9999px",
    top: "0",
    width: "100%",
    contain: "layout style",
    overflow: "clip",
  });
  document.body.append(host);
  try {
    // Do not bind Mermaid's optional click callbacks: previews are passive SVG.
    return (await mermaid.render(`diagram-preview-${++nextId}`, source, host)).svg;
  } finally {
    host.remove();
  }
}

export function renderMermaid(source: string, theme: DiagramTheme): Promise<string> {
  // Mermaid's configuration is global; serialize diagrams so a theme change in
  // one block cannot alter another block while it is being rendered.
  const result = queue.then(() => render(source, theme));
  queue = result.catch(() => {});
  return result;
}
