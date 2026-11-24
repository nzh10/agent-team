import { createContext } from "react";

// Opens a file reference ("src/a.ts:12-20", "/tmp/report.md") in the file
// viewer; null outside a workspace view, where references stay plain text.
export const FileOpenContext = createContext<((ref: string) => void) | null>(null);

export interface FileRef {
  path: string;
  line?: number;
  endLine?: number;
}

// Extensions that make a bare "name.ext" read as a file rather than code
// ("ws.send" is not one).
export const FILE_EXT =
  /\.(tsx?|jsx?|mjs|cjs|json|jsonl|md|mdx|txt|log|cpp|cppm|cc|cxx|c|h|hpp|hh|hxx|ixx|cu|cuh|py|rs|go|java|kt|swift|rb|lua|sh|bash|zsh|fish|toml|ya?ml|ini|cfg|conf|css|scss|html?|xml|svg|sql|diff|patch|cmake|lock|csv|tex|bib|proto|zig|nix|png|jpe?g|gif|webp|pdf)$/i;
// Files known by name alone.
export const FILE_NAME =
  /^(Makefile|GNUmakefile|Dockerfile|Containerfile|Justfile|LICENSE|README|CHANGELOG|\.gitignore|\.gitattributes|\.gitmodules|\.editorconfig|\.prettierrc|\.prettierignore|\.npmrc|\.nvmrc|\.clang-format|\.clang-tidy|\.clangd|\.env(\.\w+)?)$/;
// Windows drive-letter root ("C:/...", "C:\...").
export const WIN_DRIVE = /^[A-Za-z]:[\\/]/;
// Regexes, globs, and shell punctuation (backslashes are filtered in
// parseFileRef so Windows paths work while regexes stay plain code).
const NOT_A_PATH = /[*+?^$|(){}<>"'`,;]/;
// "example.com/index.html" is a site, not a folder.
const DOMAIN = /^[\w-]+(\.[\w-]+)*\.(com|org|net|io|dev|app|ai|co|cn|me|so)$/i;
const LINE_SUFFIX = /^(.+?)(?::(\d+)(?:-(\d+))?(?::\d+)?|#L?(\d+)(?:-L?(\d+))?|#[\w.-]*)?$/;

// Splits trailing line/anchor syntax from an already-accepted file reference
// (e.g. a markdown link target whose decoded path may contain spaces).
export function splitFileRef(ref: string): FileRef {
  const s = ref.trim();
  const m = LINE_SUFFIX.exec(s);
  if (!m) return { path: s };
  const line = Number(m[2] ?? m[4]) || undefined;
  const endLine = Number(m[3] ?? m[5]) || undefined;
  return {
    path: m[1],
    ...(line && { line }),
    ...(endLine && endLine > (line ?? 0) && { endLine }),
  };
}

// "path", "path:12", "path:12-20", "path:12:5", "path#L12-L20", "path#12";
// another anchor ("guide.md#setup") is dropped.
export function parseFileRef(text: string): FileRef | null {
  const s = text.trim();
  if (!s || /\s/.test(s) || s.includes("://") || NOT_A_PATH.test(s)) return null;
  const m = LINE_SUFFIX.exec(s);
  if (!m) return null;
  const path = m[1];
  const winDrive = WIN_DRIVE.test(path);
  // Keep regexes and escaped literals ("/\d+/", "foo\.ts", "\a.ts") plain.
  if (
    path.includes("\\") &&
    !winDrive &&
    !/^\.\.?\\/.test(path) &&
    (path.startsWith("/") || path.startsWith("\\") || path.includes("\\."))
  ) {
    return null;
  }
  const anchored = winDrive || /^(\/|~[\\/]|\.\.?[\\/])/.test(path);
  const segments = path.split(/[\\/]/);
  const last = segments.at(-1) ?? "";
  // A slash command or a route ("/compact"), not a folder.
  if (/^\/[^/.]+$/.test(path)) return null;
  if (!anchored && DOMAIN.test(segments[0]) && segments.length > 1) return null;
  if (segments.length === 1 && /^\.[^.]+$/.test(last) && !FILE_NAME.test(last)) return null;
  if (!anchored && !path.endsWith("/") && !FILE_EXT.test(last) && !FILE_NAME.test(last)) {
    return null;
  }
  const line = Number(m[2] ?? m[4]) || undefined;
  const endLine = Number(m[3] ?? m[5]) || undefined;
  return { path, ...(line && { line }), ...(endLine && endLine > (line ?? 0) && { endLine }) };
}

// What a markdown link points at, as a file reference to open: its href
// decoded, without "file://" or a query. Null for other schemes and for
// anchors within the page.
export function linkFileRef(href: string): string | null {
  let s = href.replace(/^file:\/\/(?:localhost)?/i, "");
  try {
    s = decodeURI(s);
  } catch {
    // Not percent-encoded after all.
  }
  // RFC 8089 Windows file URIs ("file:///C:/...", "file:///c%3A/...") carry a
  // leading slash before the drive letter; strip it so Windows path.resolve
  // does not treat "/C:/..." as a root-relative path on the current drive.
  s = s.replace(/^\/?([A-Za-z])%3A([\\/])/i, "$1:$2");
  if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
  s = s.replace(/\?[^#]*/, "");
  if (!s || s.startsWith("#")) return null;
  s = s.replace(/#(?!L?\d)[^#]*$/, "");
  if (!WIN_DRIVE.test(s) && /^[a-z][a-z0-9+-]*:(?!\d)/i.test(s)) return null;
  return s;
}
