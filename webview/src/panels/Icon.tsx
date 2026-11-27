import table from "./vscode-icons.json";

// The panels' icons: 16px line drawings in one stroke, so the rail, the
// panel headers and the row actions read as one family.
export const ICONS = {
  board: "M2.5 3.5h11v9h-11zM6.2 3.5v9M9.8 3.5v9",
  usage: "M2.5 2.5v11h11M5.5 10.5V8M8.5 10.5V5.5M11.5 10.5V3.5",
  agents: "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.6-2.2 2.6-3.5 5-3.5s4.4 1.3 5 3.5",
  files: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
  maximize: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
  restore: "M6 2.5V6H2.5M10 2.5V6h3.5M10 13.5V10h3.5M6 13.5V10H2.5",
  pin: "M2.5 3.5h11v9h-11zM10 3.5v9",
  close: "M4 4l8 8M12 4l-8 8",
  clear: "M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.7h-2.7",
  up: "M8 13V3M4 7l4-4 4 4",
  stop: "M4 4h8v8H4z",
  queue: "M2.5 8H11M7 4l4 4-4 4M13.5 4v8",
  first: "M2.5 3.5v9M13 3.5 6 8l7 4.5z",
  previous: "M12.5 3.5 5 8l7.5 4.5z",
  next: "M3.5 3.5 11 8l-7.5 4.5z",
  last: "M3 3.5 10 8l-7 4.5zM13.5 3.5v9",
  pending: "M4 8h.01M8 8h.01M12 8h.01",
  changes: "M8 2.5v6M5 5.5h6M5 12.5h6",
  play: "M5 3.5v9l7.5-4.5z",
  plus: "M8 3.5v9M3.5 8h9",
  debug: "M6 2.5v11M10 2.5v11M2.5 6h11M2.5 10h11",
  bell: "M3 11c1-1 1.5-2.5 1.5-5a3.5 3.5 0 0 1 7 0c0 2.5.5 4 1.5 5zM6.5 13a1.7 1.7 0 0 0 3 0",
  camera: "M2.5 5.5h2.3l1-2h4.4l1 2h2.3v7.5h-11zM8 11.2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  diagram: "M6 4.5 8 2.5l2 2-2 2zM2 11h4v3H2zM10 11h4v3h-4zM8 6.5V9M4 9v2M12 9v2M4 9h8",
  code: "M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4M9 2.5 7 13.5",
  diagnostics: "M2 8h2.5l1.7-4.5 3.2 9 1.9-4.5H14",
  folder: "M2 12.5V4h4.5L8 5.5h6v7z",
  branch:
    "M5.5 5v6m2 1.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0-9a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm5.5 2a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM11.5 7c0 3.5-6 1-6 4",
  menu: "M2.5 4h11m-11 4h11m-11 4h11",
  refresh: "M12.5 6A5 5 0 0 0 4 4.2L2.5 6m0-3.5V6H6m-2.5 4A5 5 0 0 0 12 11.8l1.5-1.8m0 3.5V10H10",
  sun: "M11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM8 1.5v1m0 11v1M1.5 8h1m11 0h1M3.4 3.4l.8.8m7.6 7.6.8.8m0-9.2-.8.8m-7.6 7.6-.8.8",
  moon: "M13.5 10A5.7 5.7 0 1 1 6 2.5 5.8 5.8 0 0 0 13.5 10Z",
  archive: "M2 3.5h12v2.5H2zM3.2 6v6.5h9.6V6M6.5 8.5h3",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

interface IconTable {
  file: number;
  folder: number;
  // The icons' SVG names (public/file-icons/<name>.svg).
  icons: string[];
  names: Record<string, number>;
  exts: Record<string, number>;
  folders: Record<string, number>;
}
const TABLE = table as IconTable;

// The icon vscode-icons gives a file or folder in VS Code: a file by its
// name, its longest extension, its language (folded into both by
// scripts/vscode-icons.ts), else the default one; a folder by its name.
export function fileIconName(name: string, dir = false): string {
  const base = (name.replace(/\/+$/, "").split("/").pop() ?? name).toLowerCase();
  if (dir) return TABLE.icons[TABLE.folders[base] ?? TABLE.folder];
  let i: number | undefined = TABLE.names[base];
  const parts = base.split(".");
  for (let k = 1; i === undefined && k < parts.length; k++)
    i = TABLE.exts[parts.slice(k).join(".")];
  return TABLE.icons[i ?? TABLE.file];
}

export function FileIcon({ name, dir = false }: { name: string; dir?: boolean }) {
  return (
    <img
      className="file-icon"
      src={`file-icons/${fileIconName(name, dir)}.svg`}
      alt=""
      width={16}
      height={16}
      draggable={false}
    />
  );
}
